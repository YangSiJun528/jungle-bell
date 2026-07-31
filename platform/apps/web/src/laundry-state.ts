import type { LaundryAppliance } from "./campus-client";

const AVAILABLE_STATES = new Set(["AVAILABLE", "IDLE", "READY"]);
const ACTIVE_OPERATIONAL_STATES = new Set([
  "RUNNING",
  "SCHEDULED",
  "PAUSED",
  "ERROR",
]);
const ACTIVE_PROJECTION_STATES = new Set([
  "RUNNING",
  "ESTIMATED_RUNNING",
  "OBSERVED",
  "AWAITING_COMPLETION_CONFIRMATION",
  "PAUSED",
  "ERROR",
]);

export function isLaundryApplianceAvailable(
  appliance: LaundryAppliance,
): boolean {
  if (
    appliance.operationalStatus === "ERROR" ||
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "ERROR" ||
    appliance.projection.status === "PAUSED"
  ) {
    return false;
  }
  return (
    AVAILABLE_STATES.has(appliance.operationalStatus) ||
    AVAILABLE_STATES.has(appliance.projection.status)
  );
}

export function hasActiveLaundrySession(
  appliance: LaundryAppliance,
): boolean {
  if (
    appliance.sessionId === null ||
    isLaundryApplianceAvailable(appliance)
  ) {
    return false;
  }
  return (
    ACTIVE_OPERATIONAL_STATES.has(appliance.operationalStatus) ||
    ACTIVE_PROJECTION_STATES.has(appliance.projection.status)
  );
}
