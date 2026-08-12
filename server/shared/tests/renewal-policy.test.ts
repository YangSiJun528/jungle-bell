import { describe, expect, it, vi } from "vitest";
import { hashAppSessionToken, normalizeManualPairingCode, randomManualPairingCode, sha256Hex } from "../renewal/crypto";
import {
  attendancePlanningPhasesAt,
  attendanceReminderWindowAt,
} from "../renewal/attendance-policy";

describe("renewal security primitives", () => {
  it("domain-separates desktop and mobile credential hashes", async () => {
    const suffix = "a".repeat(64);
    expect(await hashAppSessionToken(`jbd_${suffix}`)).not.toBe(await sha256Hex(`jbd_${suffix}`));
    expect(await hashAppSessionToken(`jbd_${suffix}`)).not.toBe(await hashAppSessionToken(`jbs_${suffix}`));
  });

  it("creates and normalizes an exact ten-character Crockford code", () => {
    const code = randomManualPairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(normalizeManualPairingCode("0o1i-l abcde")).toBe("00111ABCDE");
    expect(normalizeManualPairingCode("too-short")).toBeNull();
  });
});

describe("attendance reminder windows", () => {
  it.each([
    ["2026-08-03T00:00:00.000Z", "2026-08-03", "morning", "0900", false, "2026-08-03T00:15:00.000Z"],
    ["2026-08-03T00:14:59.999Z", "2026-08-03", "morning", "0900", false, "2026-08-03T00:15:00.000Z"],
    ["2026-08-03T00:15:00.000Z", "2026-08-03", "morning", "0915", false, "2026-08-03T00:30:00.000Z"],
    ["2026-08-03T01:00:00.000Z", "2026-08-03", "morning", "1000", true, "2026-08-03T01:10:00.000Z"],
    ["2026-08-03T14:00:00.000Z", "2026-08-03", "evening", "2300", false, "2026-08-03T14:15:00.000Z"],
    ["2026-08-03T15:00:00.000Z", "2026-08-03", "evening", "0000", false, "2026-08-03T15:15:00.000Z"],
    ["2026-08-03T19:00:00.000Z", "2026-08-03", "evening", "0400", true, "2026-08-03T19:10:00.000Z"],
  ])("maps %s into a deduplicated KST attendance slot", (time, attendanceDate, phase, slot, isDeadline, endsAt) => {
    expect(attendanceReminderWindowAt(Date.parse(time))).toMatchObject({
      attendanceDate,
      phase,
      slot,
      isDeadline,
      endsAtEpochMs: Date.parse(endsAt),
    });
  });

  it("honors account-specific start, end, and repeat intervals", () => {
    const schedule = {
      morningStartHour: 8,
      eveningEndHour: 2,
      morningIntervalMinutes: 30,
      eveningIntervalMinutes: 10,
    } as const;
    expect(attendanceReminderWindowAt(Date.parse("2026-08-02T23:29:00.000Z"), schedule)).toMatchObject({
      phase: "morning", slot: "0800",
    });
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T15:09:00.000Z"), schedule)).toMatchObject({
      phase: "evening", slot: "0000",
    });
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T17:00:00.000Z"), schedule)).toMatchObject({
      phase: "evening", slot: "0200", isDeadline: true,
    });
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T17:10:00.000Z"), schedule)).toBeNull();
  });

  it("finds the broad phase before loading each account schedule", () => {
    expect(attendancePlanningPhasesAt(Date.parse("2026-08-03T19:30:00.000Z"))).toEqual(["morning"]);
    expect(attendancePlanningPhasesAt(Date.parse("2026-08-03T13:59:59.999Z"))).toEqual([]);
    expect(attendancePlanningPhasesAt(Date.parse("2026-08-03T14:00:00.000Z"))).toEqual(["evening"]);
    expect(attendancePlanningPhasesAt(Date.parse("2026-08-03T19:05:00.000Z"))).toEqual(["morning", "evening"]);
    expect(attendancePlanningPhasesAt(Date.parse("2026-08-03T01:10:00.000Z"))).toEqual([]);
  });

  it("does not plan outside the configured windows", () => {
    expect(attendanceReminderWindowAt(Date.parse("2026-08-02T23:59:59.999Z"))).toBeNull();
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T01:10:00.000Z"))).toBeNull();
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T13:59:59.999Z"))).toBeNull();
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T19:10:00.000Z"))).toBeNull();
  });
});
