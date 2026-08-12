import type { ProjectedAppliance, ProjectedLaundry } from "@jungle-bell/backend-common/collection/projection";

export type LaundryAccess = "men" | "women";

export interface LaundryCapacityEstimate {
  access: LaundryAccess;
  washerAvailable: number;
  projectedDryerSupply: number;
  pendingDryerLoads: number;
  dryerHeadroom: number;
  startableLoads: number | null;
  reliable: boolean;
}

const RELIABLE_FRESHNESS = new Set(["REFRESH_OBSERVED", "WITHIN_REFRESH_WINDOW", "UNVERIFIABLE_STABLE"]);
const ACTIVE = new Set(["RUNNING", "COURSE_RUNNING"]);
const ACTIVE_PROJECTION = new Set(["OBSERVED", "ESTIMATED_RUNNING"]);
const PENDING = new Set(["RUNNING", "COURSE_RUNNING", "PAUSED", "SCHEDULED"]);
const PENDING_PROJECTION = new Set(["OBSERVED", "ESTIMATED_RUNNING", "AWAITING_COMPLETION_CONFIRMATION", "PAUSED"]);
const REQUIRED: Record<LaundryAccess, readonly number[]> = { men: [1, 2, 3, 4, 5, 6, 7], women: [6, 7, 8, 9] };

export function withLaundryCapacity(projected: ProjectedLaundry): ProjectedLaundry & {
  capacity: { basis: "WASHER_AND_DRYER_HEADROOM_60_MIN"; men: LaundryCapacityEstimate; women: LaundryCapacityEstimate };
} {
  const sourceReliable = projected.quality.collection === "SUCCESS" && RELIABLE_FRESHNESS.has(projected.quality.sourceFreshness);
  return {
    ...projected,
    capacity: {
      basis: "WASHER_AND_DRYER_HEADROOM_60_MIN",
      men: assess(projected, "men", sourceReliable),
      women: assess(projected, "women", sourceReliable),
    },
  };
}

export function assess(projected: ProjectedLaundry, access: LaundryAccess, sourceReliable = true): LaundryCapacityEstimate {
  const accessible = projected.machines.filter((machine) => zoneMatches(machine.id, access));
  const complete = REQUIRED[access].every((number) => projected.machines.some((machine) => machineNumber(machine.id) === number && machine.washer && machine.dryer));
  const washerAvailable = accessible.filter((machine) => machine.washer && available(machine.washer)).length;
  const projectedDryerSupply = accessible.filter((machine) => machine.dryer && (available(machine.dryer) || dryerWithinHour(machine.dryer))).length;
  const pendingDryerLoads = accessible.filter((machine) => machine.washer && pendingDryer(machine.washer)).length;
  const dryerHeadroom = Math.max(0, projectedDryerSupply - pendingDryerLoads);
  const reliable = sourceReliable && complete;
  return {
    access,
    washerAvailable,
    projectedDryerSupply,
    pendingDryerLoads,
    dryerHeadroom,
    startableLoads: reliable ? Math.min(washerAvailable, dryerHeadroom) : null,
    reliable,
  };
}

function available(appliance: ProjectedAppliance): boolean {
  return appliance.operationalStatus === "IDLE" && appliance.projection.status === "IDLE";
}

function dryerWithinHour(appliance: ProjectedAppliance): boolean {
  if (isError(appliance) || ["PAUSED", "AWAITING_COMPLETION_CONFIRMATION", "UNKNOWN"].includes(appliance.projection.status)) return false;
  if (!ACTIVE.has(appliance.operationalStatus) && !ACTIVE_PROJECTION.has(appliance.projection.status)) return false;
  const remaining = appliance.projection.remainingMinutes;
  return remaining !== null && Number.isFinite(remaining) && remaining >= 0 && remaining <= 60;
}

function pendingDryer(appliance: ProjectedAppliance): boolean {
  if (available(appliance) || isError(appliance)) return false;
  if (!PENDING.has(appliance.operationalStatus) && !PENDING_PROJECTION.has(appliance.projection.status)) return false;
  if (["PAUSED", "SCHEDULED"].includes(appliance.operationalStatus) || ["PAUSED", "AWAITING_COMPLETION_CONFIRMATION"].includes(appliance.projection.status)) return true;
  const remaining = appliance.projection.remainingMinutes;
  return remaining === null || !Number.isFinite(remaining) || remaining <= 60;
}

function isError(appliance: ProjectedAppliance): boolean {
  return appliance.operationalStatus === "ERROR" || appliance.projection.status === "ERROR";
}

function zoneMatches(id: string, access: LaundryAccess): boolean {
  const number = machineNumber(id);
  if (number === null) return false;
  if (number >= 6 && number <= 7) return true;
  return access === "men" ? number >= 1 && number <= 5 : number >= 8 && number <= 9;
}

function machineNumber(id: string): number | null {
  const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim());
  return match?.[1] ? Number(match[1]) : null;
}
