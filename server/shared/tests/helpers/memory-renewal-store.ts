import type {
  AppSessionRecord,
  AttendanceSnapshotRecord,
  AttendancePreferenceRecord,
  DesktopRecord,
  LaundryQueueEntryRecord,
  LaundryAvailabilityTargetRecord,
  LaundryWatchRecord,
  LmsSessionState,
  MealPeriod,
  MealPreferenceRecord,
  MealPublicationRecord,
  NotificationRecord,
  PairingRecord,
  PushDeliveryRecord,
  PushDeliveryResult,
  PushSubscriptionRecord,
  RenewalStore,
} from "../../ports/account-storage";
import type { LaundryEvent } from "../../collection/types";
import type { PlannedLaundryNotification } from "../../domain/laundry-notifications";
import { DESKTOP_ENROLLMENT_POLICY } from "../../domain/enrollment-policy";

export class MemoryRenewalStore implements RenewalStore {
  readonly enrollmentAttempts = new Map<string, { windowStartedAt: number; count: number }>();
  readonly desktopEnrolledAt = new Map<string, number>();
  readonly activatedDesktopInstallations = new Set<string>();
  readonly desktops = new Map<string, DesktopRecord>();
  readonly sessions = new Map<string, AppSessionRecord>();
  readonly pairings = new Map<string, PairingRecord>();
  readonly manualPairingAttempts = new Map<string, { windowStartedAt: number; count: number }>();
  readonly pairingCreationAttempts = new Map<string, { windowStartedAt: number; count: number }>();
  readonly snapshots = new Map<string, AttendanceSnapshotRecord>();
  readonly preferences = new Map<string, AttendancePreferenceRecord>();
  readonly mealPreferences = new Map<string, MealPreferenceRecord>();
  readonly mealPosts = new Map<string, MealPublicationRecord>();
  readonly processedMealVersions = new Map<string, number>();
  readonly laundryWatches = new Map<string, LaundryWatchRecord>();
  readonly laundryQueue = new Map<string, LaundryQueueEntryRecord>();
  readonly laundryEvents = new Map<string, LaundryEvent>();
  readonly processedLaundryEvents = new Map<string, string>();
  readonly laundryClaims = new Map<string, {
    entryId: string; machineId: string; appliance: "washer" | "dryer";
    claimToken: string; claimedAtEpochMs: number; expiresAtEpochMs: number;
  }>();
  readonly notifications = new Map<string, NotificationRecord & { nextAttempt: number; displayedAt: number | null }>();
  readonly subscriptions = new Map<string, PushSubscriptionRecord>();
  readonly deliveries = new Map<string, {
    notificationId: string; subscriptionId: string; status: string; attempts: number;
    nextAttempt: number; error: string | null; leaseToken: string | null; leaseExpiresAtEpochMs: number | null;
  }>();
  readonly desktopDeliveries = new Map<string, { notificationId: string; installationId: string; status: string; attempts: number; nextAttempt: number; error: string | null }>();
  readonly persistedValues: unknown[] = [];
  lastHousekeepingAtEpochMs: number | null = null;

  async consumeDesktopEnrollmentAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const current = this.enrollmentAttempts.get(rateKey);
    const next = !current || now - current.windowStartedAt >= windowMs
      ? { windowStartedAt: now, count: 1 }
      : { ...current, count: current.count + 1 };
    if (current && now - current.windowStartedAt < windowMs && current.count >= attemptLimit) return false;
    this.enrollmentAttempts.set(rateKey, next);
    return true;
  }

  async enrollDesktop(input: {
    candidateUserId: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<boolean> {
    if (this.desktops.has(input.installationId)) return false;
    const userId = input.candidateUserId;
    this.desktops.set(input.installationId, {
      installationId: input.installationId,
      userId,
      lastSeenAtEpochMs: input.nowEpochMs,
      lmsSessionState: "unknown",
      appVersion: null,
    });
    this.desktopEnrolledAt.set(input.installationId, input.nowEpochMs);
    if (!this.preferences.has(userId)) {
      this.preferences.set(userId, {
        enabled: true,
        morning: true,
        evening: true,
        morningStartHour: 9,
        eveningEndHour: 4,
        morningIntervalMinutes: 15,
        eveningIntervalMinutes: 15,
        skipSunday: false,
        skipAttendanceDate: null,
      });
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
    return true;
  }

  async rotateDesktopSession(input: {
    currentSessionId: string; userId: string; installationId: string; newSessionId: string;
    tokenSha256: string; nowEpochMs: number; expiresAtEpochMs: number;
  }): Promise<boolean> {
    const current = this.sessions.get(input.currentSessionId);
    if (!current || current.kind !== "desktop" || current.userId !== input.userId
      || current.installationId !== input.installationId || current.revokedAtEpochMs !== null
      || current.expiresAtEpochMs <= input.nowEpochMs) return false;
    this.sessions.set(current.id, { ...current, revokedAtEpochMs: input.nowEpochMs });
    this.sessions.set(input.newSessionId, {
      ...current, id: input.newSessionId, tokenSha256: input.tokenSha256,
      createdAtEpochMs: input.nowEpochMs, expiresAtEpochMs: input.expiresAtEpochMs,
      lastSeenAtEpochMs: input.nowEpochMs, revokedAtEpochMs: null,
    });
    this.activatedDesktopInstallations.add(input.installationId);
    this.persistedValues.push({ ...input, tokenSha256: input.tokenSha256 });
    return true;
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
    this.activatedDesktopInstallations.add(input.installationId);
    return true;
  }

  async consumeManualPairingAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const current = this.manualPairingAttempts.get(rateKey);
    if (current && now - current.windowStartedAt < windowMs && current.count >= attemptLimit) return false;
    this.manualPairingAttempts.set(rateKey, !current || now - current.windowStartedAt >= windowMs
      ? { windowStartedAt: now, count: 1 }
      : { ...current, count: current.count + 1 });
    return true;
  }

  async consumePairingCreationAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const current = this.pairingCreationAttempts.get(rateKey);
    if (current && now - current.windowStartedAt < windowMs && current.count >= attemptLimit) return false;
    this.pairingCreationAttempts.set(rateKey, !current || now - current.windowStartedAt >= windowMs
      ? { windowStartedAt: now, count: 1 }
      : { ...current, count: current.count + 1 });
    return true;
  }

  async createPairing(value: PairingRecord): Promise<boolean> {
    if (this.pairings.has(value.id)) return false;
    const active = [...this.pairings.values()].some((pairing) => pairing.desktopInstallationId
      === value.desktopInstallationId && ["pending", "claimed"].includes(pairing.status)
      && pairing.expiresAtEpochMs > value.createdAtEpochMs);
    if (active) return false;
    this.pairings.set(value.id, structuredClone(value));
    this.activatedDesktopInstallations.add(value.desktopInstallationId);
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
      if (subscription.sessionId === id) {
        this.subscriptions.set(subscriptionId, { ...subscription, revokedAtEpochMs: now });
        for (const delivery of this.deliveries.values()) {
          if (delivery.subscriptionId === subscriptionId && ["pending", "retry"].includes(delivery.status)) {
            delivery.status = "failed";
            delivery.nextAttempt = Number.MAX_SAFE_INTEGER;
            delivery.error = "MOBILE_SESSION_REVOKED";
            delivery.leaseToken = null;
            delivery.leaseExpiresAtEpochMs = null;
          }
        }
      }
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
    return [...this.preferences]
      .filter(([, value]) => value.enabled && value[phase])
      .map(([userId]) => userId);
  }

  async getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null> {
    return this.preferences.get(userId) ?? null;
  }

  async setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, _nowEpochMs: number): Promise<void> {
    this.preferences.set(userId, structuredClone(preference));
  }

  async setLegacyAttendancePreference(
    userId: string,
    preference: Pick<AttendancePreferenceRecord, "morning" | "evening" | "skipSunday" | "skipAttendanceDate">,
    _nowEpochMs: number,
  ): Promise<void> {
    const current = this.preferences.get(userId) ?? {
      enabled: true,
      morning: true,
      evening: true,
      morningStartHour: 9,
      eveningEndHour: 4,
      morningIntervalMinutes: 15,
      eveningIntervalMinutes: 15,
      skipSunday: false,
      skipAttendanceDate: null,
    };
    this.preferences.set(userId, { ...current, ...structuredClone(preference) });
  }

  async getMealPreference(userId: string): Promise<MealPreferenceRecord | null> {
    return this.mealPreferences.get(userId) ?? null;
  }

  async setMealPreference(userId: string, preference: MealPreferenceRecord): Promise<void> {
    this.mealPreferences.set(userId, structuredClone(preference));
  }

  async listUnprocessedMealPosts(limit: number): Promise<MealPublicationRecord[]> {
    return [...this.mealPosts.values()]
      .filter((post) => !this.processedMealVersions.has(`${post.id}:${post.contentSha}`))
      .sort((left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((post) => ({
        ...structuredClone(post),
        hasPriorVersion: [...this.processedMealVersions.keys()].some((key) => key.startsWith(`${post.id}:`)),
      }));
  }

  async listMealSubscriberUserIds(meal: MealPeriod, occurredAtEpochMs: number): Promise<string[]> {
    return [...this.mealPreferences.entries()]
      .filter(([, preference]) => preference.enabled && preference[meal]
        && preference.updatedAtEpochMs <= occurredAtEpochMs)
      .map(([userId]) => userId)
      .sort();
  }

  async markMealPostProcessed(postId: string, contentSha: string, nowEpochMs: number): Promise<boolean> {
    const key = `${postId}:${contentSha}`;
    if (this.processedMealVersions.has(key)) return false;
    this.processedMealVersions.set(key, nowEpochMs);
    return true;
  }

  async createLaundryWatch(value: LaundryWatchRecord, activeLimit: number): Promise<"created" | "duplicate" | "limit"> {
    const active = [...this.laundryWatches.values()].filter((watch) => watch.userId === value.userId && watch.status === "active");
    if (active.some((watch) => watch.machineId === value.machineId && watch.appliance === value.appliance
      && watch.sessionId === value.sessionId && watch.notifyWhenAvailable === value.notifyWhenAvailable)) return "duplicate";
    if (active.length >= activeLimit) return "limit";
    this.laundryWatches.set(value.id, structuredClone(value));
    return "created";
  }

  async listLaundryWatches(userId: string): Promise<LaundryWatchRecord[]> {
    return [...this.laundryWatches.values()].filter((watch) => watch.userId === userId)
      .sort((left, right) => right.createdAtEpochMs - left.createdAtEpochMs || left.id.localeCompare(right.id));
  }

  async cancelLaundryWatch(userId: string, id: string, now: number): Promise<boolean> {
    const watch = this.laundryWatches.get(id);
    if (!watch || watch.userId !== userId || watch.status !== "active" || watch.createdAtEpochMs > now) return false;
    this.laundryWatches.set(id, { ...watch, status: "cancelled", updatedAtEpochMs: now });
    return true;
  }

  async enqueueLaundry(value: Omit<LaundryQueueEntryRecord, "position">): Promise<LaundryQueueEntryRecord | null> {
    const duplicate = [...this.laundryQueue.values()].some((entry) => entry.userId === value.userId
      && entry.appliance === value.appliance && entry.machineId === value.machineId
      && (entry.status === "waiting" || (entry.status === "claimed"
        && (this.laundryClaims.get(entry.id)?.expiresAtEpochMs ?? 0) > value.joinedAtEpochMs)));
    if (duplicate) return null;
    const position = [...this.laundryQueue.values()].filter((entry) => entry.status === "waiting"
      && entry.appliance === value.appliance && entry.machineId === value.machineId).length + 1;
    const entry = { ...structuredClone(value), position };
    this.laundryQueue.set(entry.id, entry);
    return entry;
  }

  async listLaundryQueue(userId: string, now: number): Promise<LaundryQueueEntryRecord[]> {
    const terminalSince = now - 24 * 60 * 60_000;
    const entries = [...this.laundryQueue.values()];
    const waiting = entries.filter((entry) => entry.userId === userId && entry.status === "waiting")
      .map((entry) => ({ ...entry, position: entries.filter((candidate) => candidate.status === "waiting"
        && candidate.appliance === entry.appliance && candidate.machineId === entry.machineId
        && (candidate.joinedAtEpochMs < entry.joinedAtEpochMs
          || (candidate.joinedAtEpochMs === entry.joinedAtEpochMs && candidate.id <= entry.id))).length }));
    const terminal = entries.filter((entry) => entry.userId === userId && ["claimed", "expired"].includes(entry.status)
      && entry.leftAtEpochMs !== null && entry.leftAtEpochMs >= terminalSince && entry.leftAtEpochMs <= now)
      .sort((left, right) => right.leftAtEpochMs! - left.leftAtEpochMs! || right.id.localeCompare(left.id)).slice(0, 8)
      .map((entry) => ({ ...entry, position: 0 }));
    return [...waiting, ...terminal];
  }

  async cancelLaundryQueueEntry(userId: string, id: string, now: number): Promise<boolean> {
    const entry = this.laundryQueue.get(id);
    if (!entry || entry.userId !== userId || entry.status !== "waiting" || entry.joinedAtEpochMs > now) return false;
    this.laundryQueue.set(id, { ...entry, status: "cancelled", leftAtEpochMs: now, position: 0 });
    return true;
  }

  async listPendingLaundryEvents(limit: number): Promise<LaundryEvent[]> {
    return [...this.laundryEvents.values()].filter((event) => !this.processedLaundryEvents.has(event.id))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async listActiveLaundryWatches(input: {
    machineId: string; appliance: "washer" | "dryer"; sessionId: string | null;
  }): Promise<LaundryWatchRecord[]> {
    return [...this.laundryWatches.values()].filter((watch) => watch.status === "active"
      && watch.machineId === input.machineId && watch.appliance === input.appliance
      && (watch.sessionId === null || watch.sessionId === input.sessionId));
  }

  async findWaitingLaundryQueueHead(input: {
    machineId: string; appliance: "washer" | "dryer"; nowEpochMs: number;
  }): Promise<LaundryQueueEntryRecord | null> {
    const activeClaim = [...this.laundryClaims.values()].some((claim) => claim.machineId === input.machineId
      && claim.appliance === input.appliance && claim.expiresAtEpochMs > input.nowEpochMs
      && this.laundryQueue.get(claim.entryId)?.status === "claimed");
    if (activeClaim) return null;
    return [...this.laundryQueue.values()].filter((entry) => entry.status === "waiting"
      && entry.appliance === input.appliance && (entry.machineId === null || entry.machineId === input.machineId))
      .sort((left, right) => left.joinedAtEpochMs - right.joinedAtEpochMs || left.id.localeCompare(right.id))[0] ?? null;
  }

  async listLaundryAvailabilityTargets(input: {
    appliances: ReadonlyArray<{ machineId: string; appliance: "washer" | "dryer"; sessionId: string | null }>;
    nowEpochMs: number;
  }): Promise<LaundryAvailabilityTargetRecord[]> {
    const assignedQueueEntries = new Set<string>();
    const result: LaundryAvailabilityTargetRecord[] = [];
    for (const appliance of input.appliances) {
      const activeClaim = [...this.laundryClaims.values()].some((claim) => claim.machineId === appliance.machineId
        && claim.appliance === appliance.appliance && claim.expiresAtEpochMs > input.nowEpochMs
        && this.laundryQueue.get(claim.entryId)?.status === "claimed");
      const queueEntry = activeClaim ? null : [...this.laundryQueue.values()]
        .filter((entry) => entry.status === "waiting" && entry.appliance === appliance.appliance
          && (entry.machineId === null || entry.machineId === appliance.machineId)
          && !assignedQueueEntries.has(entry.id))
        .sort((left, right) => left.joinedAtEpochMs - right.joinedAtEpochMs || left.id.localeCompare(right.id))[0] ?? null;
      if (queueEntry) assignedQueueEntries.add(queueEntry.id);
      result.push({
        ...appliance, watches: await this.listActiveLaundryWatches(appliance), queueEntry,
      });
    }
    return result;
  }

  async expireLaundryQueueClaims(now: number): Promise<number> {
    let expired = 0;
    for (const claim of this.laundryClaims.values()) {
      const entry = this.laundryQueue.get(claim.entryId);
      if (entry?.status === "claimed" && claim.expiresAtEpochMs <= now) {
        this.laundryQueue.set(entry.id, { ...entry, status: "expired", position: 0 });
        expired += 1;
      }
    }
    return expired;
  }

  async applyLaundryLifecycleEvent(input: {
    eventId: string; processingToken: string; notifications: PlannedLaundryNotification[];
    completedWatchIds: string[];
    queueClaim: {
      entryId: string; userId: string; machineId: string; appliance: "washer" | "dryer";
      claimToken: string; expiresAtEpochMs: number;
    } | null;
    nowEpochMs: number;
  }): Promise<boolean> {
    if (this.processedLaundryEvents.has(input.eventId)) return false;
    this.processedLaundryEvents.set(input.eventId, input.processingToken);
    const queueClaimed = input.queueClaim ? this.claimQueue({ ...input.queueClaim, nowEpochMs: input.nowEpochMs }) : false;
    for (const planned of input.notifications) {
      const activeWatch = planned.origins.some((origin) => origin.kind === "watch"
        && this.laundryWatches.get(origin.id)?.status === "active");
      const claimedQueue = queueClaimed && planned.origins.some((origin) => origin.kind === "queue"
        && origin.id === input.queueClaim?.entryId);
      if (activeWatch || claimedQueue) await this.insertNotification(planned.notification);
    }
    for (const id of input.completedWatchIds) {
      const watch = this.laundryWatches.get(id);
      if (watch?.status === "active" && watch.createdAtEpochMs <= input.nowEpochMs) {
        this.laundryWatches.set(id, { ...watch, status: "completed", updatedAtEpochMs: input.nowEpochMs });
      }
    }
    return true;
  }

  private claimQueue(input: {
    entryId: string; userId: string; machineId: string; appliance: "washer" | "dryer"; claimToken: string;
    nowEpochMs: number; expiresAtEpochMs: number;
  }): boolean {
    const activeClaim = [...this.laundryClaims.values()].some((claim) => claim.machineId === input.machineId
      && claim.appliance === input.appliance && claim.expiresAtEpochMs > input.nowEpochMs
      && this.laundryQueue.get(claim.entryId)?.status === "claimed");
    const head = [...this.laundryQueue.values()].filter((entry) => entry.status === "waiting"
      && entry.appliance === input.appliance && (entry.machineId === null || entry.machineId === input.machineId))
      .sort((left, right) => left.joinedAtEpochMs - right.joinedAtEpochMs || left.id.localeCompare(right.id))[0];
    if (activeClaim || head?.id !== input.entryId || head.userId !== input.userId) return false;
    this.laundryQueue.set(head.id, { ...head, status: "claimed", leftAtEpochMs: input.nowEpochMs, position: 0 });
    this.laundryClaims.set(head.id, {
      entryId: head.id, machineId: input.machineId, appliance: input.appliance,
      claimToken: input.claimToken, claimedAtEpochMs: input.nowEpochMs, expiresAtEpochMs: input.expiresAtEpochMs,
    });
    return true;
  }

  async listDesktopDevices(userId: string): Promise<DesktopRecord[]> {
    return [...this.desktops.values()].filter((device) => device.userId === userId);
  }

  async insertNotification(value: NotificationRecord): Promise<boolean> {
    if ([...this.notifications.values()].some((item) => item.userId === value.userId && item.sourceEventId === value.sourceEventId)) return false;
    this.notifications.set(value.id, { ...structuredClone(value), nextAttempt: value.dueAtEpochMs, displayedAt: null });
    for (const desktop of this.desktops.values()) {
      const active = [...this.sessions.values()].some((session) => session.kind === "desktop"
        && session.userId === value.userId && session.installationId === desktop.installationId
        && session.revokedAtEpochMs === null && session.expiresAtEpochMs > value.createdAtEpochMs);
      if (desktop.userId === value.userId && active) {
        this.desktopDeliveries.set(`${value.id}:${desktop.installationId}`, {
          notificationId: value.id, installationId: desktop.installationId, status: "pending",
          attempts: 0, nextAttempt: value.dueAtEpochMs, error: null,
        });
      }
    }
    for (const subscription of await this.listActivePushSubscriptions(value.userId, value.createdAtEpochMs)) {
      const key = `${value.id}:${subscription.id}`;
      if (!this.deliveries.has(key)) this.deliveries.set(key, {
        notificationId: value.id, subscriptionId: subscription.id, status: "pending", attempts: 0,
        nextAttempt: value.dueAtEpochMs, error: null, leaseToken: null, leaseExpiresAtEpochMs: null,
      });
    }
    return true;
  }

  async listDesktopInbox(userId: string, installationId: string, now: number, limit: number): Promise<NotificationRecord[]> {
    const deliveries = [...this.desktopDeliveries.values()].filter((delivery) => delivery.installationId === installationId
      && ["pending", "retry"].includes(delivery.status) && delivery.nextAttempt <= now).slice(0, limit);
    return deliveries.flatMap((delivery) => {
      const value = this.notifications.get(delivery.notificationId);
      if (!value || value.userId !== userId || value.expiresAtEpochMs <= now) return [];
      delivery.status = "retry";
      delivery.attempts += 1;
      delivery.nextAttempt = now + 2 * 60_000;
      return [{ ...value, desktopAttempt: delivery.attempts }];
    });
  }

  async listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.notifications.values()].filter((item) => item.userId === userId)
      .sort((left, right) => right.createdAtEpochMs - left.createdAtEpochMs)
      .slice(0, limit)
      .map((item) => ({ ...item, desktopAttempt: Math.max(1, item.desktopAttempt) }));
  }

  async acknowledgeNotification(userId: string, installationId: string, id: string, outcome: "displayed" | "failed", now: number): Promise<boolean> {
    const value = this.notifications.get(id);
    const delivery = this.desktopDeliveries.get(`${id}:${installationId}`);
    if (!value || value.userId !== userId || !delivery || !["pending", "retry"].includes(delivery.status)) return false;
    if (outcome === "displayed") delivery.status = "delivered";
    else {
      delivery.status = "retry";
      delivery.nextAttempt = now + 5_000;
      delivery.error = "DESKTOP_DISPLAY_FAILED";
    }
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
          delivery.leaseToken = null;
          delivery.leaseExpiresAtEpochMs = null;
        }
      }
    }
    this.subscriptions.set(value.id, structuredClone(value));
  }

  async revokePushSubscription(userId: string, id: string, now: number): Promise<boolean> {
    const value = this.subscriptions.get(id);
    if (!value || value.userId !== userId || value.revokedAtEpochMs !== null) return false;
    this.subscriptions.set(id, { ...value, revokedAtEpochMs: now });
    for (const delivery of this.deliveries.values()) {
      if (delivery.subscriptionId === id && ["pending", "retry"].includes(delivery.status)) {
        delivery.status = "failed";
        delivery.nextAttempt = Number.MAX_SAFE_INTEGER;
        delivery.error = "PUSH_SUBSCRIPTION_REVOKED";
        delivery.leaseToken = null;
        delivery.leaseExpiresAtEpochMs = null;
      }
    }
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

  async claimDuePushDeliveries(input: {
    nowEpochMs: number; limit: number; leaseToken: string; leaseExpiresAtEpochMs: number;
  }): Promise<PushDeliveryRecord[]> {
    const now = input.nowEpochMs;
    for (const value of this.deliveries.values()) {
      const notification = this.notifications.get(value.notificationId);
      if (["pending", "retry"].includes(value.status) && notification && notification.expiresAtEpochMs <= now) {
        value.status = "failed";
        value.error = "NOTIFICATION_EXPIRED";
        value.leaseToken = null;
        value.leaseExpiresAtEpochMs = null;
      }
    }
    const selected = [...this.deliveries.values()]
      .filter((value) => ["pending", "retry"].includes(value.status) && value.nextAttempt <= now
        && (value.leaseToken === null || (value.leaseExpiresAtEpochMs ?? 0) <= now))
      .sort((left, right) => left.nextAttempt - right.nextAttempt
        || left.notificationId.localeCompare(right.notificationId))
      .slice(0, input.limit).flatMap((value) => {
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
          ? [{ value, subscription, notification }]
          : [];
      });
    for (const { value } of selected) {
      value.leaseToken = input.leaseToken;
      value.leaseExpiresAtEpochMs = input.leaseExpiresAtEpochMs;
    }
    return selected.map(({ value, subscription, notification }) => ({
      notificationId: value.notificationId, subscription, payloadJson: notification.payloadJson,
      expiresAtEpochMs: notification.expiresAtEpochMs, attempts: value.attempts, leaseToken: input.leaseToken,
    }));
  }

  async recordPushDeliveryResults(inputs: readonly PushDeliveryResult[]): Promise<void> {
    const authorized = inputs.filter((input) =>
      this.deliveries.get(`${input.notificationId}:${input.subscriptionId}`)?.leaseToken === input.leaseToken);
    const gone = new Map(authorized.filter((input) => input.status === "gone")
      .map((input) => [`${input.notificationId}:${input.subscriptionId}`, input]));
    const goneSubscriptions = new Map(authorized.filter((input) => input.status === "gone")
      .map((input) => [input.subscriptionId, input.nowEpochMs]));
    for (const [subscriptionId, nowEpochMs] of goneSubscriptions) {
      const subscription = this.subscriptions.get(subscriptionId);
      if (subscription && subscription.revokedAtEpochMs === null) {
        this.subscriptions.set(subscriptionId, { ...subscription, revokedAtEpochMs: nowEpochMs });
      }
      for (const delivery of this.deliveries.values()) {
        if (delivery.subscriptionId !== subscriptionId || !["pending", "retry"].includes(delivery.status)) continue;
        const exact = gone.get(`${delivery.notificationId}:${subscriptionId}`);
        delivery.status = exact ? "gone" : "failed";
        delivery.attempts += exact ? 1 : 0;
        delivery.nextAttempt = Number.MAX_SAFE_INTEGER;
        delivery.error = exact?.error ?? "PUSH_SUBSCRIPTION_GONE";
        delivery.leaseToken = null;
        delivery.leaseExpiresAtEpochMs = null;
      }
    }
    for (const input of authorized) {
      if (input.status === "gone" || goneSubscriptions.has(input.subscriptionId)) continue;
      const key = `${input.notificationId}:${input.subscriptionId}`;
      const value = this.deliveries.get(key);
      if (!value || value.leaseToken !== input.leaseToken) continue;
      this.deliveries.set(key, {
        ...value, status: input.status, attempts: value.attempts + 1,
        nextAttempt: input.nextAttemptAtEpochMs ?? Number.MAX_SAFE_INTEGER, error: input.error,
        leaseToken: null, leaseExpiresAtEpochMs: null,
      });
    }
  }

  async runHousekeeping(nowEpochMs: number): Promise<boolean> {
    if (this.lastHousekeepingAtEpochMs !== null && nowEpochMs - this.lastHousekeepingAtEpochMs < 60 * 60_000) {
      return false;
    }
    this.lastHousekeepingAtEpochMs = nowEpochMs;
    const cutoff = nowEpochMs - DESKTOP_ENROLLMENT_POLICY.abandonedRetentionMs;
    for (const [installationId, desktop] of this.desktops) {
      const enrolledAt = this.desktopEnrolledAt.get(installationId);
      const hasActiveMobileSession = [...this.sessions.values()].some((session) => session.userId === desktop.userId
        && session.kind === "mobile" && session.revokedAtEpochMs === null && session.expiresAtEpochMs > nowEpochMs);
      if (enrolledAt === undefined || enrolledAt >= cutoff
        || this.activatedDesktopInstallations.has(installationId) || hasActiveMobileSession) continue;
      this.desktops.delete(installationId);
      this.desktopEnrolledAt.delete(installationId);
      for (const [sessionId, session] of this.sessions) {
        if (session.userId === desktop.userId) this.sessions.delete(sessionId);
      }
      this.preferences.delete(desktop.userId);
      this.mealPreferences.delete(desktop.userId);
      this.snapshots.delete(desktop.userId);
    }
    return true;
  }
}
