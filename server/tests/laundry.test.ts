import { describe, expect, it } from "vitest";
import { normalizeLaundry, type LaundryVersion } from "../src/collector/laundry";
import { projectLaundry } from "../src/collector/projection";

function laundry(state: string, remainingMinutes: number, totalMinutes = 60): unknown {
  return {
    "워시타워_1": {
      washer: {
        runState: { currentState: state },
        remoteControlEnable: { remoteControlEnabled: state !== "END" },
        timer: {
          remainHour: Math.floor(remainingMinutes / 60),
          remainMinute: remainingMinutes % 60,
          totalHour: Math.floor(totalMinutes / 60),
          totalMinute: totalMinutes % 60,
        },
        cycle: { cycleCount: 42 },
      },
    },
  };
}

describe("laundry change detection", () => {
  it("records the session start once even when the total time changes", () => {
    const idle = normalizeLaundry(
      laundry("POWER_OFF", 0),
      "a".repeat(64),
      "2026-07-17T00:00:00.000Z",
      null,
    );
    const started = normalizeLaundry(
      laundry("WASHING", 60),
      "b".repeat(64),
      "2026-07-17T00:05:00.000Z",
      idle,
    );
    const adjusted = normalizeLaundry(
      laundry("WASHING", 70, 90),
      "c".repeat(64),
      "2026-07-17T00:10:00.000Z",
      started,
    );

    expect(started.machines[0]?.washer?.startedAt).toBe("2026-07-17T00:05:00.000Z");
    expect(adjusted.machines[0]?.washer?.startedAt).toBe("2026-07-17T00:05:00.000Z");
  });

  it("does not invent a start time when the first snapshot is already running", () => {
    const first = normalizeLaundry(
      laundry("WASHING", 60),
      "a".repeat(64),
      "2026-07-17T00:05:00.000Z",
      null,
    );

    expect(first.machines[0]?.washer?.startedAt).toBeNull();
  });

  it.each([
    { currentRemaining: 30, type: "ETA_EXTENDED", delta: 5 },
    { currentRemaining: 25, type: "COUNTDOWN_NORMAL", delta: 0 },
    { currentRemaining: 20, type: "ETA_REDUCED", delta: -5 },
  ])("classifies a five-minute change as $type", ({ currentRemaining, type, delta }) => {
    const previous = normalizeLaundry(laundry("WASHING", 30), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const current = normalizeLaundry(
      laundry("WASHING", currentRemaining),
      "b".repeat(64),
      "2026-07-17T00:05:00.000Z",
      previous,
    );

    const event = current.events.find((candidate) => candidate.type === type);
    expect(event?.etaDeltaMinutes).toBe(delta);
    expect(event?.detail.changeWindow).toEqual({
      after: "2026-07-17T00:00:00.000Z",
      atOrBefore: "2026-07-17T00:05:00.000Z",
    });
  });

  it.each([
    { currentRemaining: 28, delta: 3 },
    { currentRemaining: 22, delta: -3 },
  ])("treats a $delta-minute ETA shift as normal jitter", ({ currentRemaining }) => {
    const previous = normalizeLaundry(laundry("WASHING", 30), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const current = normalizeLaundry(
      laundry("WASHING", currentRemaining),
      "b".repeat(64),
      "2026-07-17T00:05:00.000Z",
      previous,
    );

    expect(current.events.find((candidate) => candidate.type === "COUNTDOWN_NORMAL")?.etaDeltaMinutes)
      .toBe(currentRemaining - 25);
  });

  it("does not compare ETAs across a collection gap", () => {
    const previous = normalizeLaundry(laundry("WASHING", 30), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const current = normalizeLaundry(
      laundry("WASHING", 30),
      "b".repeat(64),
      "2026-07-17T00:05:00.000Z",
      previous,
      { timingContinuity: false },
    );

    expect(current.events.filter((candidate) => candidate.type.startsWith("ETA_") || candidate.type === "COUNTDOWN_NORMAL"))
      .toHaveLength(0);
  });

  it("preserves an unknown LG profile value", () => {
    const version = normalizeLaundry(laundry("MODEL_SPECIFIC_STATE", 10), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    expect(version.machines[0]?.washer?.state).toEqual({
      code: "UNKNOWN",
      raw: "MODEL_SPECIFIC_STATE",
      known: false,
    });
    expect(version.unknownEnums).toHaveLength(1);
  });

  it("keeps collecting when a dryer runState is temporarily missing", () => {
    const dryer = (state: string | null, remainingMinutes: number) => ({
      "워시타워_7": {
        dryer: {
          ...(state === null ? {} : { runState: { currentState: state } }),
          timer: {
            remainHour: Math.floor(remainingMinutes / 60),
            remainMinute: remainingMinutes % 60,
            totalHour: 3,
            totalMinute: 0,
          },
        },
      },
    });
    const previous = normalizeLaundry(
      dryer("RUNNING", 177),
      "a".repeat(64),
      "2026-07-19T12:52:00.000Z",
      null,
    );
    const missing = normalizeLaundry(
      dryer(null, 176),
      "b".repeat(64),
      "2026-07-19T12:53:00.000Z",
      previous,
    );
    const recovered = normalizeLaundry(
      dryer("RUNNING", 175),
      "c".repeat(64),
      "2026-07-19T12:54:00.000Z",
      missing,
    );

    expect(missing.machines[0]?.dryer).toMatchObject({
      state: { code: "UNKNOWN", raw: null, known: false },
      operationalStatus: "UNKNOWN",
      remainingMinutes: 176,
      sessionId: previous.machines[0]?.dryer?.sessionId,
    });
    expect(missing.unknownEnums).toEqual([]);
    expect(missing.events).toEqual([]);
    expect(recovered.events).toEqual([]);
  });
});

describe("laundry projection", () => {
  const sourceState = {
    source: "laundry" as const,
    lastAttemptAt: "2026-07-17T00:02:00.000Z",
    lastSuccessAt: "2026-07-17T00:02:00.000Z",
    lastResponseSha: "a".repeat(64),
    lastRawKey: "raw.json",
    lastNormalizedKey: "normalized.json",
    versionFirstSeenAt: "2026-07-17T00:00:00.000Z",
    consecutiveFailures: 0,
    lastError: null,
  };

  it("does not infer completion when an estimated countdown reaches zero", () => {
    const version = normalizeLaundry(laundry("RUNNING", 1), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const projected = projectLaundry(version, sourceState, new Date("2026-07-17T00:02:00.000Z"), false);
    expect(projected.machines[0]?.washer?.projection).toMatchObject({
      remainingMinutes: 0,
      status: "AWAITING_COMPLETION_CONFIRMATION",
      estimated: true,
    });
  });

  it("keeps enum values language-neutral", () => {
    const version = normalizeLaundry(laundry("RINSING", 10), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const projected = projectLaundry(version, sourceState, new Date("2026-07-17T00:01:01.000Z"), false);
    const washer = projected.machines[0]?.washer;

    expect(washer?.state).toEqual({ code: "RINSING", raw: null, known: true });
    expect(washer?.operationalStatus).toBe("RUNNING");
    expect(projected.quality.sourceFreshness).toBe("WITHIN_REFRESH_WINDOW");
    expect(JSON.stringify(projected)).not.toMatch(/labelKo/i);
  });

  it("only reports confirmed completion from an observed END state", () => {
    const version = normalizeLaundry(laundry("END", 0), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const projected = projectLaundry(version, sourceState, new Date("2026-07-17T00:02:00.000Z"), false);
    expect(projected.machines[0]?.washer?.projection.status).toBe("CONFIRMED_COMPLETED");
  });

  it("marks the last known value stale immediately after a collection error", () => {
    const version = normalizeLaundry(laundry("RUNNING", 10), "a".repeat(64), "2026-07-17T00:00:00.000Z", null);
    const projected = projectLaundry(
      version,
      { ...sourceState, lastError: "upstream timeout", consecutiveFailures: 1 },
      new Date("2026-07-17T00:01:00.000Z"),
      false,
    );
    expect(projected.quality).toMatchObject({
      collection: "STALE",
      sourceFreshness: "COLLECTION_GAP",
      certainty: "UNAVAILABLE",
    });
  });
});
