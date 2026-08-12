import type { LaundryEvent } from "../collection/types";
import type { PlannedLaundryNotification } from "../domain/laundry-notifications";

export type SessionKind = "desktop" | "mobile";
export type LmsSessionState = "connected" | "login-required" | "unknown";

export interface AppSessionRecord {
  id: string;
  userId: string;
  installationId: string;
  kind: SessionKind;
  label: string | null;
  tokenSha256: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  lastSeenAtEpochMs: number;
  revokedAtEpochMs: number | null;
  sourcePairingId: string | null;
}

export interface PairingRecord {
  id: string;
  userId: string;
  desktopInstallationId: string;
  pairingSecretSha256: string;
  manualCodeHash: string;
  claimReceiptSha256: string | null;
  status: "pending" | "claimed" | "approved" | "consumed";
  mobileInstallationId: string | null;
  mobileLabel: string | null;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  approvedAtEpochMs: number | null;
}

export interface AttendanceSnapshotRecord {
  userId: string;
  sourceInstallationId: string;
  attendanceDate: string;
  cohortId: string | null;
  cohortStatus: "active" | "upcoming" | "ended" | "none" | "unknown";
  cohortStartDate: string | null;
  cohortEndDate: string | null;
  morningChecked: boolean;
  eveningChecked: boolean;
  collectedAtEpochMs: number;
  receivedAtEpochMs: number;
}

export interface AttendancePreferenceRecord {
  morning: boolean;
  evening: boolean;
  skipSunday: boolean;
  skipAttendanceDate: string | null;
}

export interface MealPreferenceRecord {
  enabled: boolean;
  breakfast: boolean;
  lunch: boolean;
  dinner: boolean;
  updatedAtEpochMs: number;
}

export type MealPeriod = "breakfast" | "lunch" | "dinner";

export interface MealPublicationRecord {
  id: string;
  contentSha: string;
  title: string | null;
  text: string;
  publishedAt: string | null;
  updatedAt: string | null;
  firstSeenAt: string;
  hasPriorVersion: boolean;
}

export type LaundryAppliance = "washer" | "dryer";
export type LaundryWatchStatus = "active" | "completed" | "cancelled";

export interface LaundryWatchRecord {
  id: string;
  userId: string;
  machineId: string;
  appliance: LaundryAppliance;
  sessionId: string | null;
  notifyBeforeMinutes: number;
  notifyWhenAvailable: boolean;
  status: LaundryWatchStatus;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
}

export type LaundryQueueStatus = "waiting" | "claimed" | "cancelled" | "expired";

export interface LaundryQueueEntryRecord {
  id: string;
  userId: string;
  machineId: string | null;
  appliance: LaundryAppliance;
  status: LaundryQueueStatus;
  joinedAtEpochMs: number;
  leftAtEpochMs: number | null;
  position: number;
}

export interface LaundryAvailabilityTargetRecord {
  machineId: string;
  appliance: LaundryAppliance;
  sessionId: string | null;
  watches: LaundryWatchRecord[];
  queueEntry: LaundryQueueEntryRecord | null;
}

export interface DesktopRecord {
  installationId: string;
  userId: string;
  lastSeenAtEpochMs: number | null;
  lmsSessionState: LmsSessionState;
  appVersion: string | null;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  sourceEventId: string;
  kind: string;
  title: string;
  body: string;
  path: string;
  payloadJson: string;
  createdAtEpochMs: number;
  dueAtEpochMs: number;
  expiresAtEpochMs: number;
  desktopAttempt: number;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAtEpochMs: number;
  revokedAtEpochMs: number | null;
}

export interface PushDeliveryRecord {
  notificationId: string;
  subscription: PushSubscriptionRecord;
  payloadJson: string;
  expiresAtEpochMs: number;
  attempts: number;
  leaseToken: string;
}

export interface PushDeliveryResult {
  notificationId: string;
  subscriptionId: string;
  leaseToken: string;
  status: "delivered" | "retry" | "gone" | "failed";
  nowEpochMs: number;
  nextAttemptAtEpochMs: number | null;
  error: string | null;
}

export interface RenewalStore {
  consumeDesktopEnrollmentAttempt(
    rateKey: string,
    nowEpochMs: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean>;
  enrollDesktop(input: {
    candidateUserId: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<boolean>;
  rotateDesktopSession(input: {
    currentSessionId: string;
    userId: string;
    installationId: string;
    newSessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<boolean>;
  findSessionByTokenHash(tokenSha256: string): Promise<AppSessionRecord | null>;
  hasCurrentDesktopOwnership(input: {
    sessionId: string;
    userId: string;
    installationId: string;
  }): Promise<boolean>;
  touchSession(id: string, nowEpochMs: number): Promise<void>;
  recordDesktopHeartbeat(input: {
    userId: string;
    installationId: string;
    lmsSessionState: LmsSessionState;
    appVersion: string | null;
    nowEpochMs: number;
  }): Promise<boolean>;
  consumeManualPairingAttempt(
    rateKey: string,
    nowEpochMs: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean>;
  consumePairingCreationAttempt(
    rateKey: string,
    nowEpochMs: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean>;
  createPairing(pairing: PairingRecord): Promise<boolean>;
  getPairing(id: string): Promise<PairingRecord | null>;
  findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null>;
  claimPairing(input: {
    id: string;
    receiptSha256: string;
    mobileInstallationId: string;
    mobileLabel: string;
    nowEpochMs: number;
  }): Promise<boolean>;
  approvePairing(pairingId: string, desktopInstallationId: string, session: AppSessionRecord, nowEpochMs: number): Promise<boolean>;
  consumePairing(pairingId: string, receiptSha256: string, nowEpochMs: number): Promise<boolean>;
  listMobileSessions(userId: string): Promise<AppSessionRecord[]>;
  revokeMobileSession(userId: string, sessionId: string, nowEpochMs: number): Promise<boolean>;
  putNewestAttendanceSnapshot(snapshot: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }>;
  getLatestAttendanceSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null>;
  listAttendanceSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]>;
  getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null>;
  setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, nowEpochMs: number): Promise<void>;
  getMealPreference(userId: string): Promise<MealPreferenceRecord | null>;
  setMealPreference(userId: string, preference: MealPreferenceRecord): Promise<void>;
  listUnprocessedMealPosts(limit: number): Promise<MealPublicationRecord[]>;
  listMealSubscriberUserIds(meal: MealPeriod, occurredAtEpochMs: number): Promise<string[]>;
  markMealPostProcessed(postId: string, contentSha: string, nowEpochMs: number): Promise<boolean>;
  createLaundryWatch(watch: LaundryWatchRecord, activeLimit: number): Promise<"created" | "duplicate" | "limit">;
  listLaundryWatches(userId: string): Promise<LaundryWatchRecord[]>;
  cancelLaundryWatch(userId: string, id: string, nowEpochMs: number): Promise<boolean>;
  enqueueLaundry(entry: Omit<LaundryQueueEntryRecord, "position">): Promise<LaundryQueueEntryRecord | null>;
  listLaundryQueue(userId: string, nowEpochMs: number): Promise<LaundryQueueEntryRecord[]>;
  cancelLaundryQueueEntry(userId: string, id: string, nowEpochMs: number): Promise<boolean>;
  listPendingLaundryEvents(limit: number): Promise<LaundryEvent[]>;
  listActiveLaundryWatches(input: {
    machineId: string; appliance: LaundryAppliance; sessionId: string | null;
  }): Promise<LaundryWatchRecord[]>;
  findWaitingLaundryQueueHead(input: {
    machineId: string; appliance: LaundryAppliance; nowEpochMs: number;
  }): Promise<LaundryQueueEntryRecord | null>;
  listLaundryAvailabilityTargets(input: {
    appliances: ReadonlyArray<{ machineId: string; appliance: LaundryAppliance; sessionId: string | null }>;
    nowEpochMs: number;
  }): Promise<LaundryAvailabilityTargetRecord[]>;
  expireLaundryQueueClaims(nowEpochMs: number): Promise<number>;
  applyLaundryLifecycleEvent(input: {
    eventId: string;
    processingToken: string;
    notifications: PlannedLaundryNotification[];
    completedWatchIds: string[];
    queueClaim: {
      entryId: string; userId: string; machineId: string; appliance: LaundryAppliance;
      claimToken: string; expiresAtEpochMs: number;
    } | null;
    nowEpochMs: number;
  }): Promise<boolean>;
  listDesktopDevices(userId: string): Promise<DesktopRecord[]>;
  insertNotification(notification: NotificationRecord): Promise<boolean>;
  listDesktopInbox(userId: string, installationId: string, nowEpochMs: number, limit: number): Promise<NotificationRecord[]>;
  listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]>;
  acknowledgeNotification(userId: string, installationId: string, notificationId: string, outcome: "displayed" | "failed", nowEpochMs: number): Promise<boolean>;
  upsertPushSubscription(subscription: PushSubscriptionRecord): Promise<void>;
  revokePushSubscription(userId: string, id: string, nowEpochMs: number): Promise<boolean>;
  listActivePushSubscriptions(userId: string, nowEpochMs: number): Promise<PushSubscriptionRecord[]>;
  claimDuePushDeliveries(input: {
    nowEpochMs: number;
    limit: number;
    leaseToken: string;
    leaseExpiresAtEpochMs: number;
  }): Promise<PushDeliveryRecord[]>;
  recordPushDeliveryResults(inputs: readonly PushDeliveryResult[]): Promise<void>;
  runHousekeeping(nowEpochMs: number): Promise<boolean>;
}
