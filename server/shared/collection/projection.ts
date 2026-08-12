import {
  EXPECTED_LG_REFRESH_SECONDS,
  OVERDUE_LG_REFRESH_SECONDS,
} from "./time";
import {
  toPublicLaundryAppliance,
  type LaundryApplianceSnapshot,
  type LaundryVersion,
} from "./laundry";
import type { LaundryEvent, SourceState } from "./types";

export type ProjectionStatus =
  | "OBSERVED"
  | "ESTIMATED_RUNNING"
  | "AWAITING_COMPLETION_CONFIRMATION"
  | "CONFIRMED_COMPLETED"
  | "PAUSED"
  | "ERROR"
  | "IDLE"
  | "UNKNOWN";

export type SourceFreshness =
  | "REFRESH_OBSERVED"
  | "WITHIN_REFRESH_WINDOW"
  | "REFRESH_OVERDUE"
  | "UNVERIFIABLE_STABLE"
  | "COLLECTION_GAP";

export interface ProjectedAppliance extends LaundryApplianceSnapshot {
  projection: {
    asOf: string;
    remainingMinutes: number | null;
    status: ProjectionStatus;
    estimated: boolean;
  };
}

export interface ProjectedLaundry {
  schemaVersion: 1;
  sourceVersionSha: string;
  asOf: string;
  final: boolean;
  quality: {
    collection: "SUCCESS" | "STALE";
    sourceFreshness: SourceFreshness;
    certainty: "OBSERVED_API_VALUE" | "PROVISIONAL_DEVICE_STATE" | "UNAVAILABLE";
    basis: "SOURCE_TIMESTAMP" | "HASH_CADENCE";
    lastCheckedAt: string | null;
    expectedRefreshIntervalSeconds: number;
  };
  machines: Array<{
    id: string;
    washer: ProjectedAppliance | null;
    dryer: ProjectedAppliance | null;
  }>;
  events: LaundryEvent[];
  unknownEnums: LaundryVersion["unknownEnums"];
}

function projectAppliance(appliance: LaundryApplianceSnapshot, asOf: Date): ProjectedAppliance {
  let status: ProjectionStatus;
  let remainingMinutes: number | null = appliance.remainingMinutes;
  let estimated = false;

  switch (appliance.operationalStatus) {
    case "RUNNING": {
      const finishAt = appliance.estimatedFinishAt ? Date.parse(appliance.estimatedFinishAt) : Number.NaN;
      remainingMinutes = Number.isNaN(finishAt) ? appliance.remainingMinutes : Math.max(0, Math.ceil((finishAt - asOf.getTime()) / 60_000));
      status = remainingMinutes === 0 ? "AWAITING_COMPLETION_CONFIRMATION" : "ESTIMATED_RUNNING";
      estimated = asOf.getTime() > Date.parse(appliance.observedAt);
      break;
    }
    case "COMPLETED":
      status = "CONFIRMED_COMPLETED";
      remainingMinutes = 0;
      break;
    case "PAUSED":
      status = "PAUSED";
      break;
    case "ERROR":
      status = "ERROR";
      break;
    case "IDLE":
    case "SCHEDULED":
      status = "IDLE";
      break;
    default:
      status = "UNKNOWN";
      remainingMinutes = null;
  }

  return {
    ...toPublicLaundryAppliance(appliance),
    projection: {
      asOf: asOf.toISOString(),
      remainingMinutes,
      status,
      estimated,
    },
  };
}

export function projectLaundry(
  version: LaundryVersion,
  state: SourceState | null,
  asOf: Date,
  final: boolean,
): ProjectedLaundry {
  const ageSeconds = Math.max(0, (asOf.getTime() - Date.parse(version.observedAt)) / 1000);
  const anyActive = version.machines.some((machine) =>
    [machine.washer, machine.dryer].some((appliance) => appliance?.operationalStatus === "RUNNING"),
  );
  const lastCheckedAt = state?.lastSuccessAt ?? null;
  const collectionAgeSeconds = lastCheckedAt
    ? Math.max(0, (asOf.getTime() - Date.parse(lastCheckedAt)) / 1000)
    : Number.POSITIVE_INFINITY;

  let freshness: SourceFreshness;
  if (state?.lastError || collectionAgeSeconds > 120) freshness = "COLLECTION_GAP";
  else if (ageSeconds <= 60) freshness = "REFRESH_OBSERVED";
  else if (anyActive && ageSeconds > OVERDUE_LG_REFRESH_SECONDS) freshness = "REFRESH_OVERDUE";
  else if (anyActive && ageSeconds <= EXPECTED_LG_REFRESH_SECONDS) freshness = "WITHIN_REFRESH_WINDOW";
  else freshness = "UNVERIFIABLE_STABLE";

  return {
    schemaVersion: 1,
    sourceVersionSha: version.sourceVersionSha,
    asOf: asOf.toISOString(),
    final,
    quality: {
      collection: freshness === "COLLECTION_GAP" ? "STALE" : "SUCCESS",
      sourceFreshness: freshness,
      certainty: freshness === "COLLECTION_GAP"
        ? "UNAVAILABLE"
        : anyActive && freshness !== "REFRESH_OBSERVED"
          ? "PROVISIONAL_DEVICE_STATE"
          : "OBSERVED_API_VALUE",
      basis: "HASH_CADENCE",
      lastCheckedAt,
      expectedRefreshIntervalSeconds: EXPECTED_LG_REFRESH_SECONDS,
    },
    machines: version.machines.map((machine) => ({
      id: machine.id,
      washer: machine.washer ? projectAppliance(machine.washer, asOf) : null,
      dryer: machine.dryer ? projectAppliance(machine.dryer, asOf) : null,
    })),
    events: version.events,
    unknownEnums: version.unknownEnums,
  };
}
