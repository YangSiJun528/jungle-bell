import type {
  AppSessionRecord,
  AttendanceSnapshotRecord,
  AttendancePreferenceRecord,
  DesktopRecord,
  LmsSessionState,
  NotificationRecord,
  PairingRecord,
  PushDeliveryRecord,
  PushSubscriptionRecord,
  RenewalStore,
} from "../../src/workers/account-storage";

export class MemoryRenewalStore implements RenewalStore {
  readonly subjectUsers = new Map<string, string>();
  readonly desktops = new Map<string, DesktopRecord>();
  readonly sessions = new Map<string, AppSessionRecord>();
  readonly pairings = new Map<string, PairingRecord>();
  readonly snapshots = new Map<string, AttendanceSnapshotRecord>();
  readonly preferences = new Map<string, AttendancePreferenceRecord>();
  readonly notifications = new Map<string, NotificationRecord & { nextAttempt: number; displayedAt: number | null }>();
  readonly subscriptions = new Map<string, PushSubscriptionRecord>();
  readonly deliveries = new Map<string, { notificationId: string; subscriptionId: string; status: string; attempts: number; nextAttempt: number; error: string | null }>();
  readonly persistedValues: unknown[] = [];

  async issueVerifiedDesktopSession(input: {
    candidateUserId: string;
    subjectSha256: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<void> {
    const userId = this.subjectUsers.get(input.subjectSha256) ?? input.candidateUserId;
    this.subjectUsers.set(input.subjectSha256, userId);
    this.desktops.set(input.installationId, {
      installationId: input.installationId,
      userId,
      lastSeenAtEpochMs: input.nowEpochMs,
      lmsSessionState: "connected",
      appVersion: null,
    });
    if (!this.preferences.has(userId)) {
      this.preferences.set(userId, {
        morning: true,
        evening: true,
        skipSunday: false,
        skipAttendanceDate: null,
      });
    }
    for (const [id, session] of this.sessions) {
      if (session.kind === "desktop" && session.installationId === input.installationId && session.revokedAtEpochMs === null) {
        this.sessions.set(id, { ...session, revokedAtEpochMs: input.nowEpochMs });
      }
    }
    const session: AppSessionRecord = {
      id: input.sessionId,
      userId,
      installationId: input.installationId,
      kind: "desktop",
      label: null,
      tokenSha256: input.tokenSha256,
      createdAtEpochMs: input.nowEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs,
      lastSeenAtEpochMs: input.nowEpochMs,
      revokedAtEpochMs: null,
      sourcePairingId: null,
    };
    this.sessions.set(session.id, session);
    this.persistedValues.push(structuredClone(input));
  }

  async findSessionByTokenHash(hash: string): Promise<AppSessionRecord | null> {
    return [...this.sessions.values()].find((session) => session.tokenSha256 === hash) ?? null;
  }

  async hasCurrentDesktopOwnership(input: { sessionId: string; userId: string; installationId: string }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    const desktop = this.desktops.get(input.installationId);
    return session?.kind === "desktop"
      && session.userId === input.userId
      && session.installationId === input.installationId
      && session.revokedAtEpochMs === null
      && desktop?.userId === input.userId;
  }

  async touchSession(id: string, now: number): Promise<void> {
    const value = this.sessions.get(id);
    if (value && value.lastSeenAtEpochMs <= now - 6 * 60 * 60_000) this.sessions.set(id, { ...value, lastSeenAtEpochMs: now });
  }

  async recordDesktopHeartbeat(input: { userId: string; installationId: string; lmsSessionState: LmsSessionState; appVersion: string | null; nowEpochMs: number }): Promise<boolean> {
    const value = this.desktops.get(input.installationId);
    if (!value || value.userId !== input.userId) return false;
    this.desktops.set(input.installationId, { ...value, lastSeenAtEpochMs: input.nowEpochMs, lmsSessionState: input.lmsSessionState, appVersion: input.appVersion ?? value.appVersion });
    return true;
  }

  async createPairing(value: PairingRecord): Promise<boolean> {
    if (this.pairings.has(value.id)) return false;
    this.pairings.set(value.id, structuredClone(value));
    this.persistedValues.push(value);
    return true;
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    return this.pairings.get(id) ?? null;
  }

  async findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null> {
    return [...this.pairings.values()].find((pairing) => (kind === "qr" ? pairing.pairingSecretSha256 : pairing.manualCodeHash) === hash) ?? null;
  }

  async claimPairing(input: { id: string; receiptSha256: string; mobileInstallationId: string; mobileLabel: string; nowEpochMs: number }): Promise<boolean> {
    const value = this.pairings.get(input.id);
    if (!value || value.status !== "pending" || value.expiresAtEpochMs <= input.nowEpochMs) return false;
    this.pairings.set(input.id, { ...value, status: "claimed", claimReceiptSha256: input.receiptSha256,
      mobileInstallationId: input.mobileInstallationId, mobileLabel: input.mobileLabel });
    return true;
  }

  async approvePairing(id: string, desktopId: string, session: AppSessionRecord, now: number): Promise<boolean> {
    const value = this.pairings.get(id);
    if (!value || value.status !== "claimed" || value.desktopInstallationId !== desktopId || value.expiresAtEpochMs <= now) return false;
    this.pairings.set(id, { ...value, status: "approved", approvedAtEpochMs: now });
    for (const [sessionId, current] of this.sessions) {
      if (current.kind === "mobile" && current.userId === session.userId && current.installationId === session.installationId && current.revokedAtEpochMs === null) {
        await this.revokeMobileSession(current.userId, sessionId, now);
      }
    }
    this.sessions.set(session.id, structuredClone(session));
    return true;
  }

  async consumePairing(id: string, receiptHash: string, _now: number): Promise<boolean> {
    const value = this.pairings.get(id);
    if (!value || value.status !== "approved" || value.claimReceiptSha256 !== receiptHash) return false;
    this.pairings.set(id, { ...value, status: "consumed" });
    return true;
  }

  async listMobileSessions(userId: string): Promise<AppSessionRecord[]> {
    return [...this.sessions.values()].filter((session) => session.userId === userId && session.kind === "mobile");
  }

  async revokeMobileSession(userId: string, id: string, now: number): Promise<boolean> {
    const value = this.sessions.get(id);
    if (!value || value.userId !== userId || value.kind !== "mobile" || value.revokedAtEpochMs !== null) return false;
    this.sessions.set(id, { ...value, revokedAtEpochMs: now });
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.sessionId === id) this.subscriptions.set(subscriptionId, { ...subscription, revokedAtEpochMs: now });
    }
    return true;
  }

  async putNewestAttendanceSnapshot(value: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }> {
    const current = this.snapshots.get(value.userId);
    const accepted = !current || value.collectedAtEpochMs > current.collectedAtEpochMs;
    if (accepted) this.snapshots.set(value.userId, structuredClone(value));
    return { accepted, snapshot: this.snapshots.get(value.userId)! };
  }

  async getLatestAttendanceSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null> {
    return this.snapshots.get(userId) ?? null;
  }

  async listAttendanceSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]> {
    return [...this.preferences].filter(([, value]) => value[phase]).map(([userId]) => userId);
  }

  async getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null> {
    return this.preferences.get(userId) ?? null;
  }

  async setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, _nowEpochMs: number): Promise<void> {
    this.preferences.set(userId, structuredClone(preference));
  }

  async listDesktopDevices(userId: string): Promise<DesktopRecord[]> {
    return [...this.desktops.values()].filter((device) => device.userId === userId);
  }

  async insertNotification(value: NotificationRecord): Promise<boolean> {
    if ([...this.notifications.values()].some((item) => item.userId === value.userId && item.sourceEventId === value.sourceEventId)) return false;
    this.notifications.set(value.id, { ...structuredClone(value), nextAttempt: value.dueAtEpochMs, displayedAt: null });
    return true;
  }

  async listDesktopInbox(userId: string, now: number, limit: number): Promise<NotificationRecord[]> {
    const values = [...this.notifications.values()].filter((item) => item.userId === userId && item.displayedAt === null
      && item.nextAttempt <= now && item.expiresAtEpochMs > now).slice(0, limit);
    for (const value of values) {
      value.desktopAttempt += 1;
      value.nextAttempt = now + 2 * 60_000;
    }
    return values;
  }

  async listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.notifications.values()].filter((item) => item.userId === userId)
      .sort((left, right) => right.createdAtEpochMs - left.createdAtEpochMs)
      .slice(0, limit)
      .map((item) => ({ ...item, desktopAttempt: Math.max(1, item.desktopAttempt) }));
  }

  async acknowledgeNotification(userId: string, id: string, outcome: "displayed" | "failed", now: number): Promise<boolean> {
    const value = this.notifications.get(id);
    if (!value || value.userId !== userId) return false;
    if (outcome === "displayed") value.displayedAt = now;
    else value.nextAttempt = now + 5_000;
    return true;
  }

  async upsertPushSubscription(value: PushSubscriptionRecord): Promise<void> {
    const current = this.subscriptions.get(value.id);
    if (current && (current.userId !== value.userId || current.sessionId !== value.sessionId)) {
      for (const delivery of this.deliveries.values()) {
        if (delivery.subscriptionId === value.id && ["pending", "retry"].includes(delivery.status)) {
          delivery.status = "failed";
          delivery.nextAttempt = Number.MAX_SAFE_INTEGER;
          delivery.error = "PUSH_SUBSCRIPTION_REASSIGNED";
        }
      }
    }
    this.subscriptions.set(value.id, structuredClone(value));
  }

  async revokePushSubscription(userId: string, id: string, now: number): Promise<boolean> {
    const value = this.subscriptions.get(id);
    if (!value || value.userId !== userId || value.revokedAtEpochMs !== null) return false;
    this.subscriptions.set(id, { ...value, revokedAtEpochMs: now });
    return true;
  }

  async listActivePushSubscriptions(userId: string, now: number): Promise<PushSubscriptionRecord[]> {
    return [...this.subscriptions.values()].filter((subscription) => {
      const session = this.sessions.get(subscription.sessionId);
      return subscription.userId === userId
        && subscription.revokedAtEpochMs === null
        && session?.kind === "mobile"
        && session.userId === userId
        && session.revokedAtEpochMs === null
        && session.expiresAtEpochMs > now;
    });
  }

  async queuePushDelivery(notificationId: string, subscriptionId: string, now: number): Promise<void> {
    this.deliveries.set(`${notificationId}:${subscriptionId}`, { notificationId, subscriptionId, status: "pending", attempts: 0, nextAttempt: now, error: null });
  }

  async listDuePushDeliveries(now: number, limit: number): Promise<PushDeliveryRecord[]> {
    for (const value of this.deliveries.values()) {
      const notification = this.notifications.get(value.notificationId);
      if (["pending", "retry"].includes(value.status) && notification && notification.expiresAtEpochMs <= now) {
        value.status = "failed";
        value.error = "NOTIFICATION_EXPIRED";
      }
    }
    return [...this.deliveries.values()].filter((value) => ["pending", "retry"].includes(value.status) && value.nextAttempt <= now)
      .slice(0, limit).flatMap((value) => {
        const subscription = this.subscriptions.get(value.subscriptionId);
        const session = subscription ? this.sessions.get(subscription.sessionId) : undefined;
        const notification = this.notifications.get(value.notificationId);
        return subscription
          && subscription.revokedAtEpochMs === null
          && session?.kind === "mobile"
          && session.userId === subscription.userId
          && session.revokedAtEpochMs === null
          && session.expiresAtEpochMs > now
          && notification
          && notification.userId === subscription.userId
          ? [{ notificationId: value.notificationId, subscription, payloadJson: notification.payloadJson,
              expiresAtEpochMs: notification.expiresAtEpochMs, attempts: value.attempts }]
          : [];
      });
  }

  async recordPushDeliveryResult(input: { notificationId: string; subscriptionId: string; status: "delivered" | "retry" | "gone" | "failed"; nowEpochMs: number; nextAttemptAtEpochMs: number | null; error: string | null }): Promise<void> {
    const key = `${input.notificationId}:${input.subscriptionId}`;
    const value = this.deliveries.get(key);
    if (value) this.deliveries.set(key, { ...value, status: input.status, attempts: value.attempts + 1,
      nextAttempt: input.nextAttemptAtEpochMs ?? Number.MAX_SAFE_INTEGER, error: input.error });
    if (input.status === "gone") await this.revokePushSubscription(this.subscriptions.get(input.subscriptionId)?.userId ?? "", input.subscriptionId, input.nowEpochMs);
  }
}
