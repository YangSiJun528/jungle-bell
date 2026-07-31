import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelLaundryWatch,
  createLaundryWatch,
  getAttendanceRule,
  getLaundryQueue,
  getLaundryWatches,
  getMealRule,
  joinLaundryQueue,
  leaveLaundryQueue,
  putAttendanceRule,
  putMealRule,
} from "./personal-client";

const fetchMock = vi.fn();
const watch = {
  id: "1d3cfcb3-91b6-4276-b264-51fbb61ee583",
  machineId: "워시타워_2",
  appliance: "washer",
  sessionId: "washer-session-42",
  notifyBeforeMinutes: 10,
  notifyWhenAvailable: true,
  status: "active",
  createdAtEpochMs: 1_775_000_000_000,
  updatedAtEpochMs: 1_775_000_000_000,
} as const;
const queueEntry = {
  id: "b4f29f0d-4d0f-4bed-b391-e9e57ff9a303",
  machineId: null,
  appliance: "dryer",
  status: "waiting",
  joinedAtEpochMs: 1_775_000_000_000,
  leftAtEpochMs: null,
  position: 2,
} as const;

describe("personal service API client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads and updates one server-owned meal notification rule", async () => {
    const rule = {
      enabled: true,
      breakfast: false,
      lunch: true,
      dinner: true,
      updatedAtEpochMs: 1_775_000_000_000,
    };
    respondJson(rule);
    respondJson({ ...rule, breakfast: true });

    await expect(getMealRule()).resolves.toEqual(rule);
    await expect(
      putMealRule({
        enabled: true,
        breakfast: true,
        lunch: true,
        dinner: true,
      }),
    ).resolves.toEqual({ ...rule, breakfast: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/private/meal-rule",
      expect.objectContaining({
        body: JSON.stringify({
          enabled: true,
          breakfast: true,
          lunch: true,
          dinner: true,
        }),
        credentials: "include",
        method: "PUT",
      }),
    );
  });

  it("reads and updates an opt-in attendance notification rule", async () => {
    const rule = {
      enabled: false,
      morning: false,
      evening: false,
      updatedAtEpochMs: 0,
    };
    respondJson(rule);
    respondJson({
      enabled: true,
      morning: true,
      evening: false,
      updatedAtEpochMs: 1_775_000_000_000,
    });

    await expect(getAttendanceRule()).resolves.toEqual(rule);
    await expect(
      putAttendanceRule({
        enabled: true,
        morning: true,
        evening: false,
      }),
    ).resolves.toEqual({
      enabled: true,
      morning: true,
      evening: false,
      updatedAtEpochMs: 1_775_000_000_000,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/private/attendance-rule",
      expect.objectContaining({
        body: JSON.stringify({
          enabled: true,
          morning: true,
          evening: false,
        }),
        credentials: "include",
        method: "PUT",
      }),
    );
  });

  it("lists, creates, and cancels a laundry watch", async () => {
    respondJson({ watches: [watch] });
    respondJson(watch);
    respondNoContent();

    await expect(getLaundryWatches()).resolves.toEqual([watch]);
    await expect(
      createLaundryWatch({
        machineId: "워시타워_2",
        appliance: "washer",
        sessionId: "washer-session-42",
        notifyBeforeMinutes: 10,
        notifyWhenAvailable: true,
      }),
    ).resolves.toEqual(watch);
    await expect(cancelLaundryWatch(watch.id)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/private/laundry-watches/${watch.id}`,
      expect.objectContaining({
        credentials: "include",
        method: "DELETE",
      }),
    );
  });

  it("persists voluntary laundry queue participation", async () => {
    respondJson({ entries: [queueEntry] });
    respondJson(queueEntry);
    respondNoContent();

    await expect(getLaundryQueue()).resolves.toEqual([queueEntry]);
    await expect(
      joinLaundryQueue({ machineId: null, appliance: "dryer" }),
    ).resolves.toEqual(queueEntry);
    await expect(leaveLaundryQueue(queueEntry.id)).resolves.toBeUndefined();
  });

  it("accepts recent terminal queue history without a fake position", async () => {
    const claimed = {
      ...queueEntry,
      status: "claimed",
      leftAtEpochMs: 1_775_000_001_000,
      position: null,
    } as const;
    respondJson({ entries: [queueEntry, claimed] });

    await expect(getLaundryQueue()).resolves.toEqual([
      queueEntry,
      claimed,
    ]);
  });

  it.each([
    {
      name: "a watch containing a user id",
      operation: getLaundryWatches,
      response: { watches: [{ ...watch, userId: "must-not-leak" }] },
    },
    {
      name: "an impossible queue position",
      operation: getLaundryQueue,
      response: { entries: [{ ...queueEntry, position: 0 }] },
    },
    {
      name: "an extended meal rule",
      operation: getMealRule,
      response: {
        enabled: true,
        breakfast: false,
        lunch: true,
        dinner: true,
        updatedAtEpochMs: 1_775_000_000_000,
        internalUserId: "must-not-leak",
      },
    },
    {
      name: "an extended attendance rule",
      operation: getAttendanceRule,
      response: {
        enabled: true,
        morning: true,
        evening: true,
        updatedAtEpochMs: 1_775_000_000_000,
        userId: "must-not-leak",
      },
    },
  ])("rejects $name", async ({ operation, response }) => {
    respondJson(response);

    await expect(operation()).rejects.toThrow("API_RESPONSE_INVALID");
  });
});

function respondJson(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function respondNoContent(): void {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
}
