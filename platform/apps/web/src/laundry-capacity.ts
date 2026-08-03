import type {
  LaundryAppliance,
  LaundryMachine,
} from "./campus-client";
import { isLaundryApplianceAvailable } from "./laundry-state";

export const LAUNDRY_CAPACITY_RULES = {
  forecastWindowMinutes: 60,
  maxSnapshotAgeMs: 120_000,
} as const;

export type LaundryAccess = "men" | "women";
type LaundryZone = LaundryAccess | "common" | "other";

export interface LaundryCapacityEstimate {
  readonly access: LaundryAccess;
  readonly dryerHeadroom: number;
  readonly pendingDryerLoads: number;
  readonly projectedDryerSupply: number;
  readonly reliable: boolean;
  readonly startableLoads: number | null;
  readonly washerAvailable: number;
}

export interface LaundryCapacityDataState {
  readonly collection: string | null;
  readonly hasData: boolean;
  readonly lastError: string | null;
  readonly nowEpochMs: number;
  readonly refreshFailed: boolean;
  readonly savedAtEpochMs: number | null;
  readonly sourceFreshness: string | null;
  readonly stale: boolean;
}

const RELIABLE_SOURCE_FRESHNESS = new Set([
  "REFRESH_OBSERVED",
  "WITHIN_REFRESH_WINDOW",
  "UNVERIFIABLE_STABLE",
]);
const ACTIVE_OPERATIONAL_STATES = new Set([
  "RUNNING",
  "COURSE_RUNNING",
]);
const ACTIVE_PROJECTION_STATES = new Set([
  "OBSERVED",
  "ESTIMATED_RUNNING",
]);
const PENDING_DRYER_LOAD_OPERATIONAL_STATES = new Set([
  "RUNNING",
  "COURSE_RUNNING",
  "PAUSED",
  "SCHEDULED",
]);
const PENDING_DRYER_LOAD_PROJECTION_STATES = new Set([
  "OBSERVED",
  "ESTIMATED_RUNNING",
  "AWAITING_COMPLETION_CONFIRMATION",
  "PAUSED",
]);
const MEN_REQUIRED_TOWERS = [1, 2, 3, 4, 5, 6, 7] as const;
const WOMEN_REQUIRED_TOWERS = [6, 7, 8, 9] as const;

export function assessLaundryCapacity(
  machines: readonly LaundryMachine[],
  access: LaundryAccess,
  reliable: boolean,
): LaundryCapacityEstimate {
  const accessible = machines.filter((machine) =>
    zoneMatchesAccess(machineZone(machine.id), access),
  );
  const washerAvailable = accessible.filter(
    (machine) =>
      machine.washer !== null &&
      isLaundryApplianceAvailable(machine.washer),
  ).length;
  const projectedDryerSupply = accessible.filter(
    (machine) =>
      machine.dryer !== null &&
      (isLaundryApplianceAvailable(machine.dryer) ||
        dryerAvailableWithinForecast(machine.dryer)),
  ).length;
  const pendingDryerLoads = accessible.filter(
    (machine) =>
      machine.washer !== null && pendingDryerLoad(machine.washer),
  ).length;
  const dryerHeadroom = Math.max(
    0,
    projectedDryerSupply - pendingDryerLoads,
  );
  const startableLoads = Math.min(washerAvailable, dryerHeadroom);

  return {
    access,
    dryerHeadroom,
    pendingDryerLoads,
    projectedDryerSupply,
    reliable,
    startableLoads: reliable ? startableLoads : null,
    washerAvailable,
  };
}

export function laundryCapacityDataIsReliable(
  state: LaundryCapacityDataState,
): boolean {
  if (
    !state.hasData ||
    state.stale ||
    state.refreshFailed ||
    state.lastError !== null ||
    state.collection !== "SUCCESS" ||
    !RELIABLE_SOURCE_FRESHNESS.has(state.sourceFreshness ?? "") ||
    state.savedAtEpochMs === null ||
    !Number.isFinite(state.savedAtEpochMs)
  ) {
    return false;
  }

  const ageMs = state.nowEpochMs - state.savedAtEpochMs;
  return (
    ageMs >= 0 &&
    ageMs <= LAUNDRY_CAPACITY_RULES.maxSnapshotAgeMs
  );
}

export function laundryCapacityInputsAreComplete(
  machines: readonly LaundryMachine[],
  access: LaundryAccess,
): boolean {
  const requiredTowers =
    access === "men" ? MEN_REQUIRED_TOWERS : WOMEN_REQUIRED_TOWERS;
  return requiredTowers.every((number) =>
    machines.some(
      (machine) =>
        machineNumber(machine.id) === number &&
        machine.washer !== null &&
        machine.dryer !== null,
    ),
  );
}

function dryerAvailableWithinForecast(
  appliance: LaundryAppliance,
): boolean {
  if (
    isError(appliance) ||
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "PAUSED" ||
    appliance.projection.status === "AWAITING_COMPLETION_CONFIRMATION" ||
    appliance.projection.status === "UNKNOWN" ||
    !activeCycle(appliance)
  ) {
    return false;
  }

  const remainingMinutes = projectedRemainingMinutes(appliance);
  return (
    remainingMinutes !== null &&
    remainingMinutes <= LAUNDRY_CAPACITY_RULES.forecastWindowMinutes
  );
}

function pendingDryerLoad(appliance: LaundryAppliance): boolean {
  if (isLaundryApplianceAvailable(appliance) || isError(appliance)) {
    return false;
  }
  if (
    !PENDING_DRYER_LOAD_OPERATIONAL_STATES.has(
      appliance.operationalStatus,
    ) &&
    !PENDING_DRYER_LOAD_PROJECTION_STATES.has(
      appliance.projection.status,
    )
  ) {
    return false;
  }
  if (
    appliance.operationalStatus === "PAUSED" ||
    appliance.operationalStatus === "SCHEDULED" ||
    appliance.projection.status === "AWAITING_COMPLETION_CONFIRMATION" ||
    appliance.projection.status === "PAUSED"
  ) {
    return true;
  }

  const remainingMinutes = projectedRemainingMinutes(appliance);
  return (
    remainingMinutes === null ||
    remainingMinutes <= LAUNDRY_CAPACITY_RULES.forecastWindowMinutes
  );
}

function activeCycle(appliance: LaundryAppliance): boolean {
  return (
    ACTIVE_OPERATIONAL_STATES.has(appliance.operationalStatus) ||
    ACTIVE_PROJECTION_STATES.has(appliance.projection.status)
  );
}

function projectedRemainingMinutes(
  appliance: LaundryAppliance,
): number | null {
  return appliance.projection.remainingMinutes ?? appliance.remainingMinutes;
}

function isError(appliance: LaundryAppliance): boolean {
  return (
    appliance.operationalStatus === "ERROR" ||
    appliance.projection.status === "ERROR"
  );
}

function machineZone(id: string): LaundryZone {
  const number = machineNumber(id);
  if (number !== null && number >= 1 && number <= 5) {
    return "men";
  }
  if (number !== null && number >= 6 && number <= 7) {
    return "common";
  }
  if (number !== null && number >= 8 && number <= 9) {
    return "women";
  }
  return "other";
}

function machineNumber(id: string): number | null {
  const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function zoneMatchesAccess(
  zone: LaundryZone,
  access: LaundryAccess,
): boolean {
  return zone === access || zone === "common";
}
