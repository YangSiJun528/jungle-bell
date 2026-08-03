import { describe, expect, it } from "vitest";

import type {
  LaundryAppliance,
  LaundryMachine,
} from "./campus-client";
import {
  assessLaundryCapacity,
  laundryCapacityDataIsReliable,
  laundryCapacityInputsAreComplete,
} from "./laundry-capacity";

function appliance(
  operationalStatus: string,
  remainingMinutes: number | null = null,
  projectionStatus = operationalStatus === "IDLE"
    ? "IDLE"
    : operationalStatus === "UNKNOWN"
      ? "UNKNOWN"
      : "ESTIMATED_RUNNING",
): LaundryAppliance {
  return {
    appliance: "washer",
    operationalStatus,
    remainingMinutes,
    sessionId: operationalStatus === "IDLE" ? null : "cycle",
    projection: {
      remainingMinutes,
      status: projectionStatus,
      estimated: projectionStatus === "ESTIMATED_RUNNING",
    },
  };
}

function machines(
  washerStatuses: readonly string[],
  dryerStatuses: readonly string[],
): LaundryMachine[] {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `워시타워_${index + 1}`,
    washer: {
      ...appliance(washerStatuses[index] ?? "UNKNOWN"),
      appliance: "washer" as const,
    },
    dryer: {
      ...appliance(dryerStatuses[index] ?? "UNKNOWN"),
      appliance: "dryer" as const,
    },
  }));
}

describe("laundry capacity estimate", () => {
  it("counts all-idle loads separately for men and women", () => {
    const allIdle = Array(9).fill("IDLE");
    const observations = machines(allIdle, allIdle);

    expect(assessLaundryCapacity(observations, "men", true).startableLoads)
      .toBe(7);
    expect(assessLaundryCapacity(observations, "women", true).startableLoads)
      .toBe(4);
  });

  it("includes shared towers 6 and 7 for both access groups", () => {
    const observations = machines(
      ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "IDLE", "IDLE"],
      ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "IDLE", "IDLE"],
    );

    expect(assessLaundryCapacity(observations, "men", true).startableLoads)
      .toBe(2);
    expect(assessLaundryCapacity(observations, "women", true).startableLoads)
      .toBe(2);
  });

  it("subtracts pending washer demand from dryer headroom", () => {
    const observations = machines(
      ["IDLE", "RUNNING", "RUNNING", "RUNNING", "UNKNOWN"],
      ["IDLE", "IDLE", "IDLE", "UNKNOWN", "UNKNOWN"],
    );

    const result = assessLaundryCapacity(observations, "men", true);
    expect(result.pendingDryerLoads).toBe(3);
    expect(result.dryerHeadroom).toBe(0);
    expect(result.startableLoads).toBe(0);
  });

  it("uses the 60-minute dryer forecast boundary", () => {
    const observations = machines(
      ["IDLE", "IDLE"],
      ["RUNNING", "RUNNING"],
    ).map((machine, index) => ({
      ...machine,
      dryer:
        index <= 1
          ? {
              ...machine.dryer!,
              remainingMinutes: index === 0 ? 60 : 61,
              projection: {
                remainingMinutes: index === 0 ? 60 : 61,
                status: "ESTIMATED_RUNNING",
                estimated: true,
              },
            }
          : machine.dryer,
    }));

    const result = assessLaundryCapacity(observations, "men", true);
    expect(result.projectedDryerSupply).toBe(1);
    expect(result.startableLoads).toBe(1);
  });

  it("returns an unavailable estimate when the data is unreliable", () => {
    const allIdle = Array(9).fill("IDLE");
    const result = assessLaundryCapacity(
      machines(allIdle, allIdle),
      "men",
      false,
    );

    expect(result.startableLoads).toBeNull();
  });
});

describe("laundry capacity reliability", () => {
  const nowEpochMs = Date.parse("2026-07-31T04:34:30.000Z");
  const reliable = {
    collection: "SUCCESS",
    hasData: true,
    lastError: null,
    nowEpochMs,
    refreshFailed: false,
    savedAtEpochMs: nowEpochMs - 60_000,
    sourceFreshness: "WITHIN_REFRESH_WINDOW",
    stale: false,
  } as const;

  it("rejects stale, failed, missing, and too-old snapshots", () => {
    expect(laundryCapacityDataIsReliable(reliable)).toBe(true);
    expect(laundryCapacityDataIsReliable({ ...reliable, stale: true })).toBe(false);
    expect(laundryCapacityDataIsReliable({ ...reliable, refreshFailed: true })).toBe(false);
    expect(laundryCapacityDataIsReliable({ ...reliable, hasData: false })).toBe(false);
    expect(
      laundryCapacityDataIsReliable({
        ...reliable,
        savedAtEpochMs: nowEpochMs - 120_001,
      }),
    ).toBe(false);
  });

  it("requires every washer and dryer used by each access group", () => {
    const complete = machines(Array(9).fill("IDLE"), Array(9).fill("IDLE"));
    const missingMenDryer = complete.map((machine, index) =>
      index === 0 ? { ...machine, dryer: null } : machine,
    );
    const missingCommonWasher = complete.map((machine, index) =>
      index === 5 ? { ...machine, washer: null } : machine,
    );

    expect(laundryCapacityInputsAreComplete(complete, "men")).toBe(true);
    expect(laundryCapacityInputsAreComplete(complete, "women")).toBe(true);
    expect(laundryCapacityInputsAreComplete(missingMenDryer, "men")).toBe(false);
    expect(laundryCapacityInputsAreComplete(missingMenDryer, "women")).toBe(true);
    expect(laundryCapacityInputsAreComplete(missingCommonWasher, "men")).toBe(false);
    expect(laundryCapacityInputsAreComplete(missingCommonWasher, "women")).toBe(false);
  });
});
