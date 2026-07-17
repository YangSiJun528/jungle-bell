import {
  EXPECTED_LG_REFRESH_SECONDS,
  OVERDUE_LG_REFRESH_SECONDS,
} from "./time";
import {
  laundryEventTypeLabelKo,
  operationalStatusLabelKo,
  type LaundryApplianceSnapshot,
  type LaundryVersion,
} from "./laundry";
import { lgRunStateLabelKo } from "./lg-profile";
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
    statusLabelKo: string;
    estimated: boolean;
  };
}

export interface ProjectedLaundryEvent extends LaundryEvent {
  typeLabelKo: string;
}

export interface ProjectedLaundry {
  schemaVersion: 1;
  sourceVersionSha: string;
  asOf: string;
  final: boolean;
  quality: {
    collection: "SUCCESS" | "STALE";
    collectionLabelKo: string;
    sourceFreshness: SourceFreshness;
    sourceFreshnessLabelKo: string;
    certainty: "OBSERVED_API_VALUE" | "PROVISIONAL_DEVICE_STATE" | "UNAVAILABLE";
    certaintyLabelKo: string;
    basis: "SOURCE_TIMESTAMP" | "HASH_CADENCE";
    basisLabelKo: string;
    lastCheckedAt: string | null;
    expectedRefreshIntervalSeconds: number;
  };
  machines: Array<{
    id: string;
    washer: ProjectedAppliance | null;
    dryer: ProjectedAppliance | null;
  }>;
  events: ProjectedLaundryEvent[];
  unknownEnums: LaundryVersion["unknownEnums"];
}

export function projectionStatusLabelKo(status: ProjectionStatus): string {
  const labels: Record<ProjectionStatus, string> = {
    OBSERVED: "관측값",
    ESTIMATED_RUNNING: "작동 중",
    AWAITING_COMPLETION_CONFIRMATION: "완료 확인 중",
    CONFIRMED_COMPLETED: "완료",
    PAUSED: "일시 정지",
    ERROR: "오류",
    IDLE: "사용 가능",
    UNKNOWN: "확인 불가",
  };
  return labels[status];
}

export function sourceFreshnessLabelKo(freshness: SourceFreshness): string {
  const labels: Record<SourceFreshness, string> = {
    REFRESH_OBSERVED: "원격 상태 갱신됨",
    WITHIN_REFRESH_WINDOW: "다음 원격 갱신 대기",
    REFRESH_OVERDUE: "원격 갱신 지연",
    UNVERIFIABLE_STABLE: "상태 변화 없음",
    COLLECTION_GAP: "수집 연결 지연",
  };
  return labels[freshness];
}

export function withLaundryEventLabelKo(event: LaundryEvent): ProjectedLaundryEvent {
  return { ...event, typeLabelKo: laundryEventTypeLabelKo(event.type) };
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
    ...appliance,
    state: {
      ...appliance.state,
      labelKo: appliance.state.labelKo ?? lgRunStateLabelKo(appliance.state.code),
    },
    operationalStatusLabelKo: appliance.operationalStatusLabelKo
      ?? operationalStatusLabelKo(appliance.operationalStatus),
    projection: {
      asOf: asOf.toISOString(),
      remainingMinutes,
      status,
      statusLabelKo: projectionStatusLabelKo(status),
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
      collectionLabelKo: freshness === "COLLECTION_GAP" ? "수집 지연" : "수집 정상",
      sourceFreshness: freshness,
      sourceFreshnessLabelKo: sourceFreshnessLabelKo(freshness),
      certainty: freshness === "COLLECTION_GAP"
        ? "UNAVAILABLE"
        : anyActive && freshness !== "REFRESH_OBSERVED"
          ? "PROVISIONAL_DEVICE_STATE"
          : "OBSERVED_API_VALUE",
      certaintyLabelKo: freshness === "COLLECTION_GAP"
        ? "확인 불가"
        : anyActive && freshness !== "REFRESH_OBSERVED"
          ? "기기 상태 추정"
          : "API 관측값",
      basis: "HASH_CADENCE",
      basisLabelKo: "응답 변경 주기",
      lastCheckedAt,
      expectedRefreshIntervalSeconds: EXPECTED_LG_REFRESH_SECONDS,
    },
    machines: version.machines.map((machine) => ({
      id: machine.id,
      washer: machine.washer ? projectAppliance(machine.washer, asOf) : null,
      dryer: machine.dryer ? projectAppliance(machine.dryer, asOf) : null,
    })),
    events: version.events.map(withLaundryEventLabelKo),
    unknownEnums: version.unknownEnums,
  };
}
