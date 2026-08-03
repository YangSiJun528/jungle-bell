import {
  ATTENDANCE_CLIENT_CLOCK_SKEW_MS,
  attendanceReminderWindowAt,
  createAttendanceNotificationEvent,
  isFreshAttendanceSnapshot,
  isPhaseChecked,
  type AttendanceNotificationEvent,
  type AttendanceReminderWindow,
} from "../attendance/reminder-policy.js";
import type {
  AttendanceSnapshotRecord,
  AttendanceSnapshotStore,
  DesktopDeviceRecord,
  DesktopIdentityStore,
  DesktopSessionStore,
} from "../infra/sqlite/index.js";
import type {
  AttendanceReminderFallbackReason,
} from "./contracts.js";

const DESKTOP_ONLINE_WINDOW_MS = 5 * 60 * 1_000;
const SCAN_INTERVAL_MS = 60 * 1_000;

export interface AttendanceSubscriberReader {
  listAttendanceSubscriberUserIds(
    phase: "morning" | "evening",
  ): string[];
}

export interface AttendanceNotificationLifecycle {
  collectDue(
    nowEpochMs: number,
  ): Promise<readonly AttendanceNotificationEvent[]>;
}

/**
 * Converts durable attendance rules and the latest desktop evidence into
 * deterministic reminder events. The notification repository owns durable
 * deduplication, so recreating this lifecycle after a restart is safe.
 */
export class ServerAttendanceNotificationLifecycle
  implements AttendanceNotificationLifecycle
{
  private nextScanAtEpochMs = 0;

  constructor(
    private readonly dependencies: {
      readonly rules: AttendanceSubscriberReader;
      readonly snapshots: Pick<AttendanceSnapshotStore, "getLatest">;
      readonly desktopIdentities: Pick<
        DesktopIdentityStore,
        "listDesktopDevices"
      >;
      readonly desktopSessions: Pick<
        DesktopSessionStore,
        "hasActiveForDevice"
      >;
    },
  ) {}

  async collectDue(
    nowEpochMs: number,
  ): Promise<readonly AttendanceNotificationEvent[]> {
    assertEpoch(nowEpochMs);
    const window = attendanceReminderWindowAt(nowEpochMs);
    if (
      window === null ||
      nowEpochMs < this.nextScanAtEpochMs
    ) {
      return [];
    }
    this.nextScanAtEpochMs = Math.min(
      window.endsAtEpochMs,
      Math.floor(nowEpochMs / SCAN_INTERVAL_MS) *
        SCAN_INTERVAL_MS +
        SCAN_INTERVAL_MS,
    );

    const userIds = [
      ...new Set(
        this.dependencies.rules.listAttendanceSubscriberUserIds(
          window.phase,
        ),
      ),
    ];
    const events = await Promise.all(
      userIds.map((userId) =>
        this.eventForUser(userId, window, nowEpochMs),
      ),
    );
    return events.filter(
      (event): event is AttendanceNotificationEvent => event !== null,
    );
  }

  private async eventForUser(
    userId: string,
    window: AttendanceReminderWindow,
    nowEpochMs: number,
  ): Promise<AttendanceNotificationEvent | null> {
    const snapshot = await this.dependencies.snapshots.getLatest(
      userId,
    );
    if (
      snapshot !== null &&
      snapshot.attendanceDate === window.attendanceDate
    ) {
      if (
        isPhaseChecked(snapshot, window.phase) ||
        cohortDatesProveInactive(snapshot, window.attendanceDate)
      ) {
        return null;
      }
      if (!isFreshAttendanceSnapshot(snapshot, nowEpochMs)) {
        return this.fallbackEvent(userId, snapshot, window, nowEpochMs);
      }
      if (snapshot.cohortStatus === "active") {
        return createAttendanceNotificationEvent({
          userId,
          window,
          status: "unchecked",
          reason: null,
        });
      }
      if (
        snapshot.cohortStatus === "upcoming" ||
        snapshot.cohortStatus === "ended" ||
        snapshot.cohortStatus === "none"
      ) {
        return null;
      }
    }

    return this.fallbackEvent(userId, snapshot, window, nowEpochMs);
  }

  private async fallbackEvent(
    userId: string,
    snapshot: AttendanceSnapshotRecord | null,
    window: AttendanceReminderWindow,
    nowEpochMs: number,
  ): Promise<AttendanceNotificationEvent> {
    const reason = await this.fallbackReason(
      userId,
      snapshot,
      window,
      nowEpochMs,
    );
    return createAttendanceNotificationEvent({
      userId,
      window,
      status: "unverified",
      reason,
    });
  }

  private async fallbackReason(
    userId: string,
    snapshot: AttendanceSnapshotRecord | null,
    window: AttendanceReminderWindow,
    nowEpochMs: number,
  ): Promise<AttendanceReminderFallbackReason> {
    const devices = await this.dependencies.desktopIdentities
      .listDesktopDevices(userId);
    const recentlySeen = devices.filter((device) =>
      isRecentlySeen(device, nowEpochMs),
    );
    const active = (
      await Promise.all(
        recentlySeen.map(async (device) => ({
          device,
          active: await this.dependencies.desktopSessions
            .hasActiveForDevice({
              userId,
              desktopDeviceId: device.desktopDeviceId,
              nowEpochMs,
            }),
        })),
      )
    )
      .filter((item) => item.active)
      .map((item) => item.device);

    if (active.length === 0) {
      return "desktop-offline";
    }
    if (
      !active.some((device) => device.lmsSessionState === "connected") &&
      active.some(
        (device) => device.lmsSessionState === "login-required",
      )
    ) {
      return "login-required";
    }
    if (
      snapshot === null ||
      snapshot.attendanceDate !== window.attendanceDate
    ) {
      return "snapshot-missing";
    }
    return "snapshot-stale";
  }
}

function cohortDatesProveInactive(
  snapshot: AttendanceSnapshotRecord,
  attendanceDate: string,
): boolean {
  return (
    (snapshot.cohortStatus === "upcoming" &&
      snapshot.cohortStartDate !== null &&
      attendanceDate < snapshot.cohortStartDate) ||
    (snapshot.cohortStatus === "ended" &&
      snapshot.cohortEndDate !== null &&
      attendanceDate > snapshot.cohortEndDate)
  );
}

function isRecentlySeen(
  device: DesktopDeviceRecord,
  nowEpochMs: number,
): boolean {
  return (
    device.lastSeenAtEpochMs !== null &&
    nowEpochMs - device.lastSeenAtEpochMs <=
      DESKTOP_ONLINE_WINDOW_MS &&
    device.lastSeenAtEpochMs <=
      nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS
  );
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Attendance lifecycle time is invalid.");
  }
}
