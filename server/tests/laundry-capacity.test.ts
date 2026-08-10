import { describe, expect, it } from "vitest";
import { assess } from "../src/collector/laundry-capacity";
import type { ProjectedLaundry, ProjectedAppliance } from "../src/collector/projection";

function appliance(status: ProjectedAppliance["operationalStatus"], remainingMinutes: number | null = 0): ProjectedAppliance {
  const projectionStatus: ProjectedAppliance["projection"]["status"] = status === "RUNNING"
    ? "ESTIMATED_RUNNING"
    : status === "COMPLETED"
      ? "CONFIRMED_COMPLETED"
      : status === "SCHEDULED"
        ? "IDLE"
      : status;
  return {
    machineId: "machine", appliance: "washer", observedAt: "2026-08-03T00:00:00.000Z",
    state: { code: status, raw: null, known: true }, operationalStatus: status,
    remainingMinutes: remainingMinutes ?? 0, totalMinutes: 60, startedAt: "1970-01-01T00:00:00.000Z",
    estimatedFinishAt: null, remoteControlEnabled: null, cycleCount: null, sessionId: null, errorCode: null,
    projection: { asOf: "2026-08-03T00:00:00.000Z", remainingMinutes, status: projectionStatus, estimated: status === "RUNNING" },
  };
}

function laundry(washers: string[], dryers: string[]): ProjectedLaundry {
  return {
    schemaVersion: 1, sourceVersionSha: "a".repeat(64), asOf: "2026-08-03T00:00:00.000Z", final: false,
    quality: { collection: "SUCCESS", sourceFreshness: "REFRESH_OBSERVED", certainty: "OBSERVED_API_VALUE", basis: "HASH_CADENCE", lastCheckedAt: "2026-08-03T00:00:00.000Z", expectedRefreshIntervalSeconds: 300 },
    machines: Array.from({ length: 9 }, (_, index) => ({
      id: `워시타워_${index + 1}`,
      washer: appliance((washers[index] ?? "UNKNOWN") as ProjectedAppliance["operationalStatus"]),
      dryer: { ...appliance((dryers[index] ?? "UNKNOWN") as ProjectedAppliance["operationalStatus"]), appliance: "dryer" },
    })), events: [], unknownEnums: [],
  };
}

describe("laundry startable load capacity", () => {
  it("reports exact men/women loads that have washer and downstream dryer headroom", () => {
    const data = laundry(Array(9).fill("IDLE"), Array(9).fill("IDLE"));
    expect(assess(data, "men").startableLoads).toBe(7);
    expect(assess(data, "women").startableLoads).toBe(4);
  });

  it("subtracts active washer loads from available dryer supply", () => {
    const data = laundry(["IDLE", "RUNNING", "RUNNING", "RUNNING"], ["IDLE", "IDLE", "IDLE"]);
    expect(assess(data, "men")).toMatchObject({ pendingDryerLoads: 3, dryerHeadroom: 0, startableLoads: 0 });
  });

  it("withholds a numeric estimate when a required tower is incomplete", () => {
    const data = laundry(Array(9).fill("IDLE"), Array(9).fill("IDLE"));
    data.machines[0]!.dryer = null;
    expect(assess(data, "men")).toMatchObject({ reliable: false, startableLoads: null });
  });

  it("does not overstate dryer headroom when an active cycle has no ETA", () => {
    const data = laundry(Array(9).fill("IDLE"), Array(9).fill("IDLE"));
    data.machines[0]!.dryer = { ...appliance("RUNNING", null), appliance: "dryer" };
    data.machines[1]!.washer = appliance("RUNNING", null);

    expect(assess(data, "men")).toMatchObject({
      projectedDryerSupply: 6,
      pendingDryerLoads: 1,
      dryerHeadroom: 5,
      startableLoads: 5,
    });
  });
});
