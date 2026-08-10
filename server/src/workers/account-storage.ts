import type { LaundryEvent } from "../collector/types";
import type { PlannedLaundryNotification } from "../domain/laundry-notifications";
import { D1AttendanceRepository } from "../repositories/d1-attendance-repository";
import { D1NotificationRepository } from "../repositories/d1-notification-repository";
import { D1PersonalControlsRepository } from "../repositories/d1-personal-controls-repository";
import { D1SessionRepository } from "../repositories/d1-session-repository";
import { D1HousekeepingRepository } from "../repositories/d1-housekeeping-repository";

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

export class D1RenewalStore implements RenewalStore {
  private readonly attendance: D1AttendanceRepository;
  private readonly notifications: D1NotificationRepository;
  private readonly personal: D1PersonalControlsRepository;
  private readonly sessions: D1SessionRepository;
  private readonly housekeeping: D1HousekeepingRepository;

  constructor(db: D1Database) {
    this.attendance = new D1AttendanceRepository(db);
    this.notifications = new D1NotificationRepository(db);
    this.personal = new D1PersonalControlsRepository(db);
    this.sessions = new D1SessionRepository(db);
    this.housekeeping = new D1HousekeepingRepository(db);
  }

  async consumeDesktopEnrollmentAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    return this.sessions.consumeDesktopEnrollmentAttempt(rateKey, now, windowMs, attemptLimit);
  }

  async enrollDesktop(input: {
    candidateUserId: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<boolean> {
    return this.sessions.enrollDesktop(input);
  }

  async rotateDesktopSession(input: {
    currentSessionId: string; userId: string; installationId: string; newSessionId: string;
    tokenSha256: string; nowEpochMs: number; expiresAtEpochMs: number;
  }): Promise<boolean> {
    return this.sessions.rotateDesktop(input);
  }

  async findSessionByTokenHash(hash: string): Promise<AppSessionRecord | null> {
    return this.sessions.findByTokenHash(hash);
  }

  async hasCurrentDesktopOwnership(input: { sessionId: string; userId: string; installationId: string }): Promise<boolean> {
    return this.sessions.hasCurrentDesktopOwnership(input);
  }

  async touchSession(id: string, now: number): Promise<void> {
    return this.sessions.touch(id, now);
  }

  async recordDesktopHeartbeat(input: { userId: string; installationId: string; lmsSessionState: LmsSessionState; appVersion: string | null; nowEpochMs: number }): Promise<boolean> {
    return this.sessions.heartbeat(input);
  }

  async consumeManualPairingAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    return this.sessions.consumeManualPairingAttempt(rateKey, now, windowMs, attemptLimit);
  }

  async consumePairingCreationAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    return this.sessions.consumePairingCreationAttempt(rateKey, now, windowMs, attemptLimit);
  }

  async createPairing(value: PairingRecord): Promise<boolean> {
    return this.sessions.createPairing(value);
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    return this.sessions.getPairing(id);
  }

  async findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null> {
    return this.sessions.findPairingByProof(kind, hash);
  }

  async claimPairing(input: { id: string; receiptSha256: string; mobileInstallationId: string; mobileLabel: string; nowEpochMs: number }): Promise<boolean> {
    return this.sessions.claimPairing(input);
  }

  async approvePairing(pairingId: string, desktopId: string, value: AppSessionRecord, now: number): Promise<boolean> {
    return this.sessions.approvePairing(pairingId, desktopId, value, now);
  }

  async consumePairing(id: string, receiptHash: string, _now: number): Promise<boolean> {
    return this.sessions.consumePairing(id, receiptHash);
  }

  async listMobileSessions(userId: string): Promise<AppSessionRecord[]> {
    return this.sessions.listMobileSessions(userId);
  }

  async revokeMobileSession(userId: string, id: string, now: number): Promise<boolean> {
    return this.sessions.revokeMobileSession(userId, id, now);
  }

  async putNewestAttendanceSnapshot(value: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }> {
    return this.attendance.putNewestSnapshot(value);
  }

  async getLatestAttendanceSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null> {
    return this.attendance.getLatestSnapshot(userId);
  }

  async listAttendanceSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]> {
    return this.attendance.listSubscriberUserIds(phase);
  }

  async getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null> {
    return this.attendance.getPreference(userId);
  }

  async setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, now: number): Promise<void> {
    return this.attendance.setPreference(userId, preference, now);
  }

  async getMealPreference(userId: string): Promise<MealPreferenceRecord | null> {
    return this.personal.getMealPreference(userId);
  }

  async setMealPreference(userId: string, preference: MealPreferenceRecord): Promise<void> {
    return this.personal.setMealPreference(userId, preference);
  }

  async listUnprocessedMealPosts(limit: number): Promise<MealPublicationRecord[]> {
    return this.personal.listUnprocessedMealPosts(limit);
  }

  async listMealSubscriberUserIds(meal: MealPeriod, occurredAtEpochMs: number): Promise<string[]> {
    return this.personal.listMealSubscriberUserIds(meal, occurredAtEpochMs);
  }

  async markMealPostProcessed(postId: string, contentSha: string, nowEpochMs: number): Promise<boolean> {
    return this.personal.markMealPostProcessed(postId, contentSha, nowEpochMs);
  }

  async createLaundryWatch(value: LaundryWatchRecord, activeLimit: number): Promise<"created" | "duplicate" | "limit"> {
    return this.personal.createWatch(value, activeLimit);
  }

  async listLaundryWatches(userId: string): Promise<LaundryWatchRecord[]> {
    return this.personal.listWatches(userId);
  }

  async cancelLaundryWatch(userId: string, id: string, now: number): Promise<boolean> {
    return this.personal.cancelWatch(userId, id, now);
  }

  async enqueueLaundry(value: Omit<LaundryQueueEntryRecord, "position">): Promise<LaundryQueueEntryRecord | null> {
    return this.personal.enqueue(value);
  }

  async listLaundryQueue(userId: string, now: number): Promise<LaundryQueueEntryRecord[]> {
    return this.personal.listQueue(userId, now);
  }

  async cancelLaundryQueueEntry(userId: string, id: string, now: number): Promise<boolean> {
    return this.personal.cancelQueueEntry(userId, id, now);
  }

  async listPendingLaundryEvents(limit: number): Promise<LaundryEvent[]> {
    return this.personal.listPendingEvents(limit);
  }

  async listActiveLaundryWatches(input: {
    machineId: string; appliance: LaundryAppliance; sessionId: string | null;
  }): Promise<LaundryWatchRecord[]> {
    return this.personal.listActiveWatches(input);
  }

  async findWaitingLaundryQueueHead(input: {
    machineId: string; appliance: LaundryAppliance; nowEpochMs: number;
  }): Promise<LaundryQueueEntryRecord | null> {
    return this.personal.findWaitingQueueHead(input);
  }

  async listLaundryAvailabilityTargets(input: {
    appliances: ReadonlyArray<{ machineId: string; appliance: LaundryAppliance; sessionId: string | null }>;
    nowEpochMs: number;
  }): Promise<LaundryAvailabilityTargetRecord[]> {
    return this.personal.listAvailabilityTargets(input);
  }

  async expireLaundryQueueClaims(now: number): Promise<number> {
    return this.personal.expireQueueClaims(now);
  }

  async applyLaundryLifecycleEvent(input: {
    eventId: string; processingToken: string; notifications: PlannedLaundryNotification[];
    completedWatchIds: string[];
    queueClaim: {
      entryId: string; userId: string; machineId: string; appliance: LaundryAppliance;
      claimToken: string; expiresAtEpochMs: number;
    } | null;
    nowEpochMs: number;
  }): Promise<boolean> {
    return this.personal.applyLifecycleEvent(input);
  }

  async listDesktopDevices(userId: string): Promise<DesktopRecord[]> {
    return this.attendance.listDesktopDevices(userId);
  }

  async insertNotification(value: NotificationRecord): Promise<boolean> {
    return this.notifications.insert(value);
  }

  async listDesktopInbox(userId: string, installationId: string, now: number, limit: number): Promise<NotificationRecord[]> {
    return this.notifications.listDesktopInbox(userId, installationId, now, limit);
  }

  async listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]> {
    return this.notifications.listHistory(userId, limit);
  }

  async acknowledgeNotification(userId: string, installationId: string, id: string, outcome: "displayed" | "failed", now: number): Promise<boolean> {
    return this.notifications.acknowledgeDesktop(userId, installationId, id, outcome, now);
  }

  async upsertPushSubscription(value: PushSubscriptionRecord): Promise<void> {
    return this.notifications.upsertSubscription(value);
  }

  async revokePushSubscription(userId: string, id: string, now: number): Promise<boolean> {
    return this.notifications.revokeSubscription(userId, id, now);
  }

  async listActivePushSubscriptions(userId: string, now: number): Promise<PushSubscriptionRecord[]> {
    return this.notifications.listActiveSubscriptions(userId, now);
  }

  async claimDuePushDeliveries(input: {
    nowEpochMs: number; limit: number; leaseToken: string; leaseExpiresAtEpochMs: number;
  }): Promise<PushDeliveryRecord[]> {
    return this.notifications.claimDuePushes(input);
  }

  async recordPushDeliveryResults(inputs: readonly PushDeliveryResult[]): Promise<void> {
    return this.notifications.recordPushResults(inputs);
  }

  async runHousekeeping(nowEpochMs: number): Promise<boolean> {
    return this.housekeeping.run(nowEpochMs);
  }
}
