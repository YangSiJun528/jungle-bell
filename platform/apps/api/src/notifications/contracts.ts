import { z } from "zod";

import type {
  ApplianceKind,
  LaundryQueueEntry,
  LaundryWatch,
} from "../campus/contracts.js";

export const notificationKindSchema = z.enum([
  "meal-published",
  "laundry-finishing",
  "laundry-completed",
  "laundry-available",
  "laundry-attention",
  "attendance-action-required",
  "login-required",
]);
export type NotificationKind = z.infer<
  typeof notificationKindSchema
>;

export const notificationChannelSchema = z.enum([
  "web-push",
  "desktop",
]);
export type NotificationChannel = z.infer<
  typeof notificationChannelSchema
>;

export const notificationContentSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(240),
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          value.startsWith("/") &&
          !value.startsWith("//") &&
          !value.includes("\\"),
        "path must be same-origin",
      ),
  })
  .strict();

export interface NotificationIntent {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly sourceEventId: string;
  readonly dedupeKey: string;
  readonly content: z.infer<typeof notificationContentSchema>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly targetDeviceId: string | null;
  readonly occurredAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export type MealPeriod = "breakfast" | "lunch" | "dinner";

export type LaundryState =
  | "AVAILABLE"
  | "BUSY"
  | "PAUSED"
  | "ERROR"
  | "COMPLETED"
  | "OFFLINE"
  | "UNKNOWN";

export type NotificationSourceEvent =
  | {
      readonly kind: "meal-published";
      readonly sourceEventId: string;
      readonly meal: MealPeriod;
      readonly serviceDate: string;
      readonly contentSha: string;
      readonly preview: string;
      readonly occurredAtEpochMs: number;
    }
  | {
      readonly kind: "laundry-transition";
      readonly sourceEventId: string;
      readonly machineId: string;
      readonly appliance: ApplianceKind;
      readonly sessionId: string | null;
      readonly previousState: LaundryState | null;
      readonly currentState: LaundryState;
      readonly remainingMinutes: number | null;
      readonly occurredAtEpochMs: number;
    }
  | {
      readonly kind: "attendance-action-required";
      readonly sourceEventId: string;
      readonly userId: string;
      readonly attendanceDate: string;
      readonly phase: "morning" | "evening";
      readonly minutesRemaining: number | null;
      readonly occurredAtEpochMs: number;
    }
  | {
      readonly kind: "login-required";
      readonly sourceEventId: string;
      readonly userId: string;
      readonly desktopDeviceId: string | null;
      readonly reason: "expired" | "missing" | "rejected";
      readonly occurredAtEpochMs: number;
    };

export interface NotificationTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly channel: NotificationChannel;
  /**
   * web-push: push subscription id; desktop: desktop device id.
   */
  readonly destinationId: string;
  readonly enabled: boolean;
}

export interface NotificationTargetDirectory {
  listTargets(userId: string): Promise<readonly NotificationTarget[]>;
}

export interface NotificationRuleReader {
  listMealSubscriberUserIds(meal: MealPeriod): string[];
  isAttendancePhaseEnabled(
    userId: string,
    phase: "morning" | "evening",
  ): boolean;
  listActiveWatches(input: {
    readonly machineId: string;
    readonly appliance: ApplianceKind;
    readonly sessionId?: string | null;
  }): LaundryWatch[];
  findWaitingQueueHead(input: {
    readonly machineId: string | null;
    readonly appliance: ApplianceKind;
  }): LaundryQueueEntry | null;
}

export interface StoredNotificationEvent {
  readonly id: string;
  readonly intent: NotificationIntent;
  readonly createdAtEpochMs: number;
}

export interface NotificationDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly channel: NotificationChannel;
  readonly destinationId: string;
  readonly status:
    | "pending"
    | "leased"
    | "awaiting_ack"
    | "retry"
    | "delivered"
    | "failed"
    | "cancelled";
  readonly attempt: number;
  readonly availableAtEpochMs: number;
  readonly leaseUntilEpochMs: number | null;
  readonly event: StoredNotificationEvent;
}

export const desktopNotificationAckSchema = z
  .object({
    outcome: z.enum(["displayed", "dismissed", "failed"]),
    occurredAtEpochMs: z.number().int().nonnegative(),
  })
  .strict();

export type DesktopNotificationAck = z.infer<
  typeof desktopNotificationAckSchema
>;

export interface DesktopNotificationItem {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly createdAtEpochMs: number;
  readonly attempt: number;
}
