import type {
  AppSessionRecord, AttendancePreferenceRecord, AttendanceSnapshotRecord, DesktopRecord,
  DesktopUiSessionRecord,
  LegacyAttendancePreferenceRecord,
  LaundryAppliance, LaundryAvailabilityTargetRecord, LaundryWatchRecord,
  LmsSessionState, MealPeriod, MealPreferenceRecord, MealPublicationRecord, NotificationRecord,
  PairingRecord, PushDeliveryRecord, PushDeliveryResult, PushSubscriptionRecord, RenewalStore,
} from "../ports/account-storage";
import type { PlannedLaundryNotification } from "../domain/laundry-notifications";
import type { LaundryEvent } from "../collection/types";
import type { SqlDatabase } from "../ports/sql-database";
import { D1AttendanceRepository } from "./d1-attendance-repository";
import { D1HousekeepingRepository } from "./d1-housekeeping-repository";
import { D1NotificationRepository } from "./d1-notification-repository";
import { D1PersonalControlsRepository } from "./d1-personal-controls-repository";
import { D1SessionRepository } from "./d1-session-repository";

export class D1RenewalStore implements RenewalStore {
  private readonly attendance: D1AttendanceRepository;
  private readonly notifications: D1NotificationRepository;
  private readonly personal: D1PersonalControlsRepository;
  private readonly sessions: D1SessionRepository;
  private readonly housekeeping: D1HousekeepingRepository;

  constructor(db: SqlDatabase) {
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

  async hasCurrentDesktopOwnership(input: {
    sessionId: string; userId: string; installationId: string; nowEpochMs?: number;
  }): Promise<boolean> {
    return this.sessions.hasCurrentDesktopOwnership(input);
  }

  async replaceDesktopUiSession(value: DesktopUiSessionRecord): Promise<boolean> {
    return this.sessions.replaceDesktopUiSession(value);
  }

  async findDesktopUiSessionByTokenHash(tokenSha256: string): Promise<DesktopUiSessionRecord | null> {
    return this.sessions.findDesktopUiSessionByTokenHash(tokenSha256);
  }

  async deleteDesktopUiSession(input: {
    parentSessionId: string; userId: string; installationId: string; origin: string;
  }): Promise<boolean> {
    return this.sessions.deleteDesktopUiSession(input);
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

  async setLegacyAttendancePreference(
    userId: string,
    preference: LegacyAttendancePreferenceRecord,
    now: number,
  ): Promise<void> {
    return this.attendance.setLegacyPreference(userId, preference, now);
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

  async listPendingLaundryEvents(limit: number): Promise<LaundryEvent[]> {
    return this.personal.listPendingEvents(limit);
  }

  async listActiveLaundryWatches(input: {
    machineId: string; appliance: LaundryAppliance; sessionId: string | null;
  }): Promise<LaundryWatchRecord[]> {
    return this.personal.listActiveWatches(input);
  }

  async listLaundryAvailabilityTargets(input: {
    appliances: ReadonlyArray<{ machineId: string; appliance: LaundryAppliance; sessionId: string | null }>;
  }): Promise<LaundryAvailabilityTargetRecord[]> {
    return this.personal.listAvailabilityTargets(input);
  }

  async applyLaundryLifecycleEvent(input: {
    eventId: string; processingToken: string; notifications: PlannedLaundryNotification[];
    completedWatchIds: string[];
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
