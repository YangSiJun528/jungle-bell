import { describe, expect, it } from "vitest";

import type { LaundryAppliance } from "./campus-client";
import {
  hasActiveLaundrySession,
  isLaundryApplianceAvailable,
} from "./laundry-state";

function appliance(
  overrides: Partial<LaundryAppliance> = {},
): LaundryAppliance {
  return {
    appliance: "washer",
    operationalStatus: "RUNNING",
    remainingMinutes: 12,
    sessionId: "cycle-1",
    projection: {
      remainingMinutes: 12,
      status: "ESTIMATED_RUNNING",
      estimated: true,
    },
    ...overrides,
  };
}

describe("laundry appliance state", () => {
  it("does not revive a stale cycle id on an idle appliance", () => {
    const idle = appliance({
      operationalStatus: "IDLE",
      sessionId: "old-cycle",
      projection: {
        remainingMinutes: 0,
        status: "IDLE",
        estimated: false,
      },
    });

    expect(isLaundryApplianceAvailable(idle)).toBe(true);
    expect(hasActiveLaundrySession(idle)).toBe(false);
  });

  it("keeps an error cycle visible as an active session", () => {
    const error = appliance({
      operationalStatus: "ERROR",
      projection: {
        remainingMinutes: null,
        status: "ERROR",
        estimated: false,
      },
    });

    expect(isLaundryApplianceAvailable(error)).toBe(false);
    expect(hasActiveLaundrySession(error)).toBe(true);
  });

  it("does not let an idle projection hide an operational error", () => {
    const error = appliance({
      operationalStatus: "ERROR",
      projection: {
        remainingMinutes: 0,
        status: "IDLE",
        estimated: false,
      },
    });

    expect(isLaundryApplianceAvailable(error)).toBe(false);
    expect(hasActiveLaundrySession(error)).toBe(true);
  });

  it("does not attach a completed cycle id to a new watch", () => {
    const completed = appliance({
      operationalStatus: "COMPLETED",
      projection: {
        remainingMinutes: 0,
        status: "COMPLETED",
        estimated: false,
      },
    });

    expect(hasActiveLaundrySession(completed)).toBe(false);
  });
});
