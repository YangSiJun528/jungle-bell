import {
    normalizeManualPairingCode,
} from '@/domain/connections/manual-pairing-code';
import type {
    DashboardLaundryMachine,
    LaundryCapacityEstimate,
    LaundryCapacitySnapshot,
} from '@/domain/laundry/capacity';
import {
    normalizeNotificationInboxSnapshot,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';
import {
    createDashboardPersonalApi,
    type DashboardPersonalApi,
} from './personal-api';
import {
    createDashboardDesktopSettingsApi,
    type DashboardDesktopSettingsApi,
} from './desktop-settings';
import {createDesktopHttpSessionManager} from './desktop-http-session';
import {
    createHttpApiClient,
    type AccountApiPath,
    type PairingApiPath,
} from './http-api-client';
import {
    createPlatformAdapter,
    type PlatformAdapter,
} from '@/platform/platform-adapter';
export type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryWatch,
    LaundryWatchInput,
    MealPreferences,
    MealPreferencesInput,
} from './personal-api';

export type DashboardFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export interface DashboardApiOptions {
    campusApiBaseUrl?: string;
    platformApiBaseUrl?: string;
    fetcher?: DashboardFetch;
    platformAdapter?: PlatformAdapter;
}

export interface DashboardLaundryAppliance {
    appliance?: 'washer' | 'dryer';
    operationalStatus?: string;
    projection?: {
        status?: string;
        remainingMinutes?: number;
        estimated?: boolean;
    } | null;
    state?: {code?: string; labelKo?: string} | null;
    remainingMinutes?: number | null;
    totalMinutes?: number;
    startedAt?: string | null;
    estimatedFinishAt?: string | null;
    observedAt?: string;
    sessionId?: string | null;
    errorCode?: string | null;
}

export interface DashboardLaundrySnapshot {
    schemaVersion: number;
    asOf: string;
    final: boolean;
    quality: {
        collection: string;
        sourceFreshness: string;
        lastCheckedAt: string | null;
        expectedRefreshIntervalSeconds: number;
    };
    machines: DashboardLaundryMachine[];
    capacity: LaundryCapacitySnapshot | null;
}

export interface DashboardMealPost {
    id: string;
    kind?: 'PINNED_MENU' | 'DAILY_MENU' | 'OTHER';
    contentSha?: string;
    title: string | null;
    text: string;
    pinned?: boolean;
    publishedAt: string | null;
    updatedAt?: string | null;
    permalink: string | null;
    status?: string | null;
    images?: DashboardMealImage[];
    firstSeenAt?: string;
    lastSeenAt?: string;
}

export interface DashboardMealImage {
    sha: string;
    url: string;
    contentType: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
    extension: 'avif' | 'gif' | 'jpg' | 'jpeg' | 'png' | 'webp';
    width: number | null;
    height: number | null;
    byteLength: number;
}

export interface DashboardWeeklyMealMenu {
    weekKey: string;
    contentSha: string;
    post: DashboardMealPost;
}

export interface DashboardCurrentWeeklyMealMenu {
    targetWeekKey: string;
    status: 'AVAILABLE' | 'AWAITING_UPDATE';
    contentSha: string | null;
    post: DashboardMealPost | null;
}

export interface DashboardMealHistoryMonth {
    posts: DashboardMealPost[];
}

export interface DashboardMealsSnapshot {
    asOf: string;
    lastCheckedAt: string | null;
    data: {
        schemaVersion: 2;
        dailyMenus: DashboardMealPost[];
        pinnedMenus: DashboardMealPost[];
        recentMenus: DashboardMealPost[];
        currentWeeklyMenu: DashboardCurrentWeeklyMealMenu | null;
        weeklyMenus: DashboardWeeklyMealMenu[];
    };
}

export interface AttendanceSnapshot {
    attendanceDate: string;
    cohortId: string | null;
    cohortStatus: string;
    cohortStartDate: string | null;
    cohortEndDate: string | null;
    morningChecked: boolean;
    eveningChecked: boolean;
    collectedAt: string;
}

export type AttendanceData =
    | {
        status: 'available';
        freshness: 'fresh' | 'stale';
        lastSyncedAt: string;
        snapshot: AttendanceSnapshot;
    }
    | {
        status: 'unavailable';
        freshness: 'missing';
        lastSyncedAt: null;
        snapshot: null;
    };

export interface DesktopDevice {
    id: string;
    deviceLabel: string | null;
    lastSeenAt: string | null;
    lmsSessionState: 'unknown' | 'connected' | 'login-required';
    health: 'unknown' | 'online' | 'offline';
    appVersion: string | null;
}

export type AttendanceDashboard =
    | {state: 'auth-required'}
    | {state: 'loaded'; attendance: AttendanceData; devices: DesktopDevice[]};

export interface DesktopConnectionState {
    state: 'disconnected' | 'unknown' | 'connected' | 'reset-required';
    credentialPersistent: boolean;
    lastVerifiedAt: string | null;
    lastSeenAt: string | null;
    health: 'unknown' | 'online' | 'offline' | null;
    lmsSessionState: 'unknown' | 'connected' | 'login-required';
}

export interface MobilePairingCreated {
    pairingId: string;
    qrPayload: string;
    manualCode: string;
    expiresAt: string;
}

export interface PairingClaim {
    claimId: string;
    status: 'awaiting-desktop-approval';
}

export interface MobilePairingStatus {
    status: 'pending' | 'claimed' | 'approved' | 'completed' | 'expired';
    claim: {
        claimId: string;
        deviceLabel: string;
        confirmationCode: string;
    } | null;
}

export interface MobileSession {
    deviceId: string;
    deviceLabel: string;
    installationId: string;
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string;
    pushEnabled: boolean;
    status: 'active' | 'revoked' | 'expired';
}

export interface DashboardNotification {
    id: string;
    kind: string;
    title: string;
    body: string;
    path: string;
    createdAtEpochMs: number;
    expiresAtEpochMs: number;
    attempt: number;
}

export interface DesktopTestNotificationResult {
    snapshot: NotificationInboxSnapshot;
    systemDelivered: boolean;
    mobileQueued: number | null;
}

export interface DashboardApi extends DashboardPersonalApi, DashboardDesktopSettingsApi {
    getPublicLaundry(): Promise<DashboardLaundrySnapshot>;
    getPublicMeals(): Promise<DashboardMealsSnapshot>;
    getPublicMealHistoryMonth(month: string): Promise<DashboardMealHistoryMonth>;
    getAttendance(): Promise<AttendanceDashboard>;
    getDesktopConnectionState(): Promise<DesktopConnectionState>;
    resetDesktopIdentity(): Promise<DesktopConnectionState>;
    refreshPlatformSync(): Promise<void>;
    openLmsLogin(): Promise<void>;
    createMobilePairing(): Promise<MobilePairingCreated>;
    getMobilePairingStatus(pairingId: string): Promise<MobilePairingStatus>;
    approveMobilePairing(pairingId: string, claimId: string): Promise<void>;
    listMobileSessions(): Promise<MobileSession[]>;
    revokeMobileSession(deviceId: string): Promise<void>;
    claimManualPairing(input: {
        manualCode: string;
        deviceLabel: string;
        installationId: string;
    }): Promise<PairingClaim>;
    claimQrPairing(input: {
        pairingId: string;
        challenge: string;
        deviceLabel: string;
        installationId: string;
    }): Promise<PairingClaim>;
    completePairing(pairingId: string): Promise<'waiting' | 'completed'>;
    disconnectMobileSession(): Promise<void>;
    getNotifications(): Promise<DashboardNotification[]>;
    getDesktopNotificationInbox(): Promise<NotificationInboxSnapshot>;
    markDesktopNotificationRead(id: string): Promise<NotificationInboxSnapshot>;
    activateDesktopNotification(id: string): Promise<NotificationInboxSnapshot>;
    sendDesktopTestNotification(): Promise<DesktopTestNotificationResult>;
    sendMobileTestNotification(): Promise<number>;
    getPushPublicKey(): Promise<string>;
    registerPushSubscription(subscription: PushSubscriptionJSON): Promise<void>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PAIRING_ID = new RegExp(`^jbp_${UUID}$`, 'u');
const CLAIM_ID = new RegExp(`^jbp_${UUID}$`, 'u');
const PAIRING_CHALLENGE = /^jbpc_[0-9a-f]{64}$/u;
const UUID_IDENTIFIER = new RegExp(`^${UUID}$`, 'u');
const PUSH_SUBSCRIPTION_ID = /^jbps_[0-9a-f]{64}$/u;
const MOBILE_INSTALLATION_ID = /^jbmi_[0-9a-f]{32}$/u;
const MOBILE_SESSION_ID = new RegExp(`^jbsi_${UUID}$`, 'u');
const ATTENDANCE_COHORT_STATUSES = new Set(['active', 'upcoming', 'ended', 'none', 'unknown']);
const NOTIFICATION_KINDS = new Set([
    'meal-published',
    'laundry-finishing',
    'laundry-completed',
    'laundry-available',
    'laundry-attention',
    'attendance-action-required',
    'login-required',
    'test',
]);

export function createDashboardApi(options: DashboardApiOptions = {}): DashboardApi {
    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const platform = options.platformAdapter ?? createPlatformAdapter({
        runningInTauri: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    });
    const nativeBridge = platform.native;
    const adapterApiBase = platform.kind === 'desktop'
        ? import.meta.env.VITE_PLATFORM_API_URL ?? ''
        : '';
    const configuredCampusBase = options.campusApiBaseUrl ?? adapterApiBase;
    const campusBase = normalizeBaseUrl(configuredCampusBase);
    const pageOrigin = typeof window !== 'undefined' && /^https?:$/u.test(window.location.protocol)
        ? window.location.origin
        : null;
    const mealAssetOrigin = campusBase || (platform.kind === 'browser' ? pageOrigin : null);
    const platformBase = normalizeBaseUrl(
        options.platformApiBaseUrl ?? adapterApiBase,
    );
    const desktopSession = platform.accountAuthentication.kind === 'desktop-session'
        ? createDesktopHttpSessionManager({nativeBridge})
        : undefined;
    const httpClient = createHttpApiClient({
        fetcher,
        publicBase: campusBase,
        platformBase,
        accountAuthentication: desktopSession
            ? {kind: 'desktop-session', session: desktopSession}
            : {kind: 'cookie'},
    });

    const publicJson = async (path: `/api/public/${string}`): Promise<unknown> => {
        const response = await httpClient.publicResponse(path, {
            method: 'GET',
        });
        return responseJson(response);
    };

    const pairingResponse = (path: PairingApiPath, init: RequestInit = {}): Promise<Response> =>
        httpClient.pairingResponse(path, init);

    const accountResponse = (path: AccountApiPath, init: RequestInit = {}): Promise<Response> =>
        httpClient.accountResponse(path, init);

    const pairingJson = async (path: PairingApiPath, init: RequestInit = {}): Promise<unknown> =>
        responseJson(await pairingResponse(path, init));

    const accountJson = async (path: AccountApiPath, init: RequestInit = {}): Promise<unknown> =>
        responseJson(await accountResponse(path, init));

    const accountNoContent = async (path: AccountApiPath, init: RequestInit): Promise<void> => {
        const response = await accountResponse(path, init);
        if (!response.ok) throw await responseError(response);
        if (response.status !== 204) throw new Error('API_RESPONSE_INVALID');
    };

    const personalApi = createDashboardPersonalApi({
        httpClient,
    });
    const desktopSettingsApi = createDashboardDesktopSettingsApi(nativeBridge);

    return {
        ...personalApi,
        ...desktopSettingsApi,
        async getPublicLaundry() {
            const value = await publicJson('/api/public/laundry');
            return parseDashboardLaundrySnapshot(value);
        },

        async getPublicMeals() {
            const value = await publicJson('/api/public/meals');
            return parseDashboardMealsSnapshot(value, mealAssetOrigin);
        },

        async getPublicMealHistoryMonth(month) {
            if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            const value = await publicJson(`/api/public/meals/history?month=${month}`);
            return parseDashboardMealHistoryMonth(value, mealAssetOrigin);
        },

        async getAttendance() {
            const response = await accountResponse('/api/me/attendance', {method: 'GET'});
            if (response.status === 401) return {state: 'auth-required'};
            const attendanceValue = await responseJson(response);
            const source = exactRecord(attendanceValue, ['attendance', 'freshness', 'devices']);
            return {
                state: 'loaded',
                attendance: parseAttendancePayload(attendanceValue, true),
                devices: parseDevices(source.devices),
            };
        },

        async getDesktopConnectionState() {
            return parseDesktopConnection(await nativeBridge.getDesktopConnectionState());
        },

        async resetDesktopIdentity() {
            desktopSession?.clear();
            return parseDesktopConnection(await nativeBridge.resetDesktopIdentity());
        },

        async refreshPlatformSync() {
            await nativeBridge.refreshPlatformSync();
        },

        async openLmsLogin() {
            await nativeBridge.openLmsLogin();
        },

        async createMobilePairing() {
            return parsePairingCreated(await accountJson('/api/me/pairings', {
                method: 'POST',
                body: JSON.stringify({}),
            }));
        },

        async getMobilePairingStatus(pairingId) {
            assertIdentifier(pairingId, PAIRING_ID, true);
            return parsePairingStatus(await accountJson(
                `/api/me/pairings/${encodeURIComponent(pairingId)}`,
                {method: 'GET'},
            ));
        },

        async approveMobilePairing(pairingId, claimId) {
            assertIdentifier(pairingId, PAIRING_ID, true);
            assertIdentifier(claimId, CLAIM_ID, true);
            await accountNoContent(`/api/me/pairings/${encodeURIComponent(pairingId)}/approve`, {
                method: 'POST',
                body: JSON.stringify({claimId}),
            });
        },

        async listMobileSessions() {
            const value = await accountJson('/api/me/mobile-sessions', {method: 'GET'});
            return parseMobileSessions(value);
        },

        async revokeMobileSession(deviceId) {
            assertIdentifier(deviceId, MOBILE_SESSION_ID, true);
            await accountNoContent(
                `/api/me/mobile-sessions/${encodeURIComponent(deviceId)}`,
                {method: 'DELETE'},
            );
        },

        async claimManualPairing(input) {
            const manualCode = normalizeManualPairingCode(input.manualCode);
            if (!/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(manualCode)
                || !validMobileClaimIdentity(input.deviceLabel, input.installationId)) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            return parsePairingClaim(await pairingJson('/api/pairings/claims', {
                method: 'POST',
                body: JSON.stringify({
                    manualCode,
                    installationId: input.installationId,
                    deviceLabel: input.deviceLabel,
                }),
            }));
        },

        async claimQrPairing(input) {
            assertIdentifier(input.pairingId, PAIRING_ID, true);
            if (!PAIRING_CHALLENGE.test(input.challenge)
                || !validMobileClaimIdentity(input.deviceLabel, input.installationId)) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            return parsePairingClaim(await pairingJson(
                `/api/pairings/${encodeURIComponent(input.pairingId)}/claims`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        challenge: input.challenge,
                        installationId: input.installationId,
                        deviceLabel: input.deviceLabel,
                    }),
                },
            ));
        },

        async completePairing(pairingId) {
            assertIdentifier(pairingId, PAIRING_ID, true);
            const response = await pairingResponse(`/api/pairings/${encodeURIComponent(pairingId)}/complete`, {
                method: 'POST',
                body: JSON.stringify({}),
            });
            if (response.status === 409) {
                const value = await safeJson(response);
                if (recordOrNull(value)?.error === 'PAIRING_NOT_APPROVED') return 'waiting';
            }
            if (!response.ok) throw await responseError(response);
            if (response.status !== 204) throw new Error('API_RESPONSE_INVALID');
            return 'completed';
        },

        async disconnectMobileSession() {
            await accountNoContent('/api/me/session', {method: 'DELETE'});
        },

        async getNotifications() {
            const value = await accountJson('/api/me/notifications?limit=20', {method: 'GET'});
            return parseNotifications(exactRecord(value, ['notifications']).notifications);
        },

        async getDesktopNotificationInbox() {
            const snapshot = normalizeNotificationInboxSnapshot(
                await nativeBridge.getNotificationInboxSnapshot(),
            );
            if (!snapshot) throw new Error('API_RESPONSE_INVALID');
            return snapshot;
        },

        async markDesktopNotificationRead(id) {
            if (!/^\d+$/u.test(id)) throw new Error('API_CLIENT_INVALID_ARGUMENT');
            const snapshot = normalizeNotificationInboxSnapshot(
                await nativeBridge.markNotificationRead(id),
            );
            if (!snapshot) throw new Error('API_RESPONSE_INVALID');
            return snapshot;
        },

        async activateDesktopNotification(id) {
            if (!/^\d+$/u.test(id)) throw new Error('API_CLIENT_INVALID_ARGUMENT');
            const snapshot = normalizeNotificationInboxSnapshot(
                await nativeBridge.activateNotification(id),
            );
            if (!snapshot) throw new Error('API_RESPONSE_INVALID');
            return snapshot;
        },

        async sendDesktopTestNotification() {
            const value = exactRecord(
                await nativeBridge.sendTestNotification(),
                ['snapshot', 'systemDelivered', 'mobileQueued'],
            );
            const snapshot = normalizeNotificationInboxSnapshot(value.snapshot);
            const mobileQueued = value.mobileQueued;
            if (!snapshot
                || typeof value.systemDelivered !== 'boolean'
                || (mobileQueued !== null
                    && (!Number.isSafeInteger(mobileQueued) || (mobileQueued as number) < 0 || (mobileQueued as number) > 100))) {
                throw new Error('API_RESPONSE_INVALID');
            }
            return {snapshot, systemDelivered: value.systemDelivered, mobileQueued: mobileQueued as number | null};
        },

        async sendMobileTestNotification() {
            const value = exactRecord(await accountJson('/api/me/notifications/test', {
                method: 'POST',
                body: JSON.stringify({}),
            }), ['notificationId', 'queued']);
            if (!Number.isSafeInteger(value.queued) || (value.queued as number) < 1) {
                throw new Error('API_RESPONSE_INVALID');
            }
            validatedIdentifier(text(value.notificationId, 36), UUID_IDENTIFIER);
            return value.queued as number;
        },

        async getPushPublicKey() {
            const value = exactRecord(
                await accountJson('/api/me/push/vapid-public-key', {method: 'GET'}),
                ['publicKey'],
            );
            const publicKey = text(value.publicKey, 87);
            if (!/^B[A-Za-z0-9_-]{86}$/u.test(publicKey)) throw new Error('API_RESPONSE_INVALID');
            return publicKey;
        },

        async registerPushSubscription(subscription) {
            const keys = subscription.keys;
            if (!subscription.endpoint || !keys?.p256dh || !keys.auth) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            const value = exactRecord(await accountJson('/api/me/push/subscriptions', {
                method: 'PUT',
                body: JSON.stringify({
                    endpoint: subscription.endpoint,
                    keys: {p256dh: keys.p256dh, auth: keys.auth},
                }),
            }), ['subscriptionId']);
            validatedIdentifier(text(value.subscriptionId, 69), PUSH_SUBSCRIPTION_ID);
        },
    };
}

function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/u, '');
    if (!trimmed) return '';
    const parsed = new URL(trimmed);
    const localHttp = parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !localHttp) {
        throw new Error('DASHBOARD_API_URL_INVALID');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/') {
        throw new Error('DASHBOARD_API_URL_INVALID');
    }
    return parsed.origin;
}

async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) throw await responseError(response);
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!type.includes('application/json')) throw new Error('API_RESPONSE_INVALID');
    return response.json();
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function responseError(response: Response): Promise<Error> {
    const body = recordOrNull(await safeJson(response));
    const code = typeof body?.error === 'string' ? body.error : `HTTP_${response.status}`;
    return new Error(code);
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    const source = record(value);
    const actualKeys = Object.keys(source);
    if (actualKeys.length !== keys.length
        || keys.some((key) => !Object.prototype.hasOwnProperty.call(source, key))) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return source;
}

function text(value: unknown, max = 512): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function nullableText(value: unknown, max = 512): string | null {
    return value === null ? null : text(value, max);
}

function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('API_RESPONSE_INVALID');
    return value;
}

function finiteNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('API_RESPONSE_INVALID');
    return value;
}

function refreshIntervalSeconds(value: unknown): number {
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 1
        || value > 3_600) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function safeEpochMillis(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function boundedLaundryCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 64) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function array(value: unknown, max = 128): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Error('API_RESPONSE_INVALID');
    return value;
}

function iso(value: unknown): string {
    const valueText = text(value, 64);
    if (!Number.isFinite(Date.parse(valueText))) throw new Error('API_RESPONSE_INVALID');
    return valueText;
}

function nullableIso(value: unknown): string | null {
    return value === null ? null : iso(value);
}

function calendarDate(value: unknown): string {
    const valueText = text(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(valueText)) throw new Error('API_RESPONSE_INVALID');
    const [yearText, monthText, dayText] = valueText.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return valueText;
}

function nullableCalendarDate(value: unknown): string | null {
    return value === null ? null : calendarDate(value);
}

function machineZone(id: string): DashboardLaundryMachine['zone'] {
    const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim());
    const number = match?.[1] ? Number(match[1]) : null;
    if (number !== null && number >= 1 && number <= 5) return 'men';
    if (number !== null && number >= 6 && number <= 7) return 'common';
    if (number !== null && number >= 8 && number <= 9) return 'women';
    return 'other';
}

export function parseDashboardLaundrySnapshot(value: unknown): DashboardLaundrySnapshot {
    const source = record(value);
    const quality = record(source.quality);
    if (source.schemaVersion !== 1
        || (quality.collection !== 'SUCCESS' && quality.collection !== 'STALE')
        || ![
            'REFRESH_OBSERVED',
            'WITHIN_REFRESH_WINDOW',
            'REFRESH_OVERDUE',
            'UNVERIFIABLE_STABLE',
            'COLLECTION_GAP',
        ].includes(String(quality.sourceFreshness))) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        schemaVersion: 1,
        asOf: iso(source.asOf),
        final: boolean(source.final),
        quality: {
            collection: text(quality.collection, 64),
            sourceFreshness: text(quality.sourceFreshness, 64),
            lastCheckedAt: nullableIso(quality.lastCheckedAt),
            expectedRefreshIntervalSeconds: refreshIntervalSeconds(quality.expectedRefreshIntervalSeconds),
        },
        machines: array(source.machines, 64).map((entry) => {
            const machine = record(entry);
            const id = text(machine.id, 128);
            return {
                id,
                zone: machineZone(id),
                washer: machine.washer === null ? null : parseLaundryAppliance(machine.washer),
                dryer: machine.dryer === null ? null : parseLaundryAppliance(machine.dryer),
            };
        }),
        capacity: source.capacity === undefined || source.capacity === null
            ? null
            : parseLaundryCapacity(source.capacity),
    };
}

function parseLaundryCapacity(value: unknown): LaundryCapacitySnapshot {
    const source = exactRecord(value, ['basis', 'men', 'women']);
    if (source.basis !== 'WASHER_AND_DRYER_HEADROOM_60_MIN') {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        basis: source.basis,
        men: parseLaundryCapacityEstimate(source.men, 'men'),
        women: parseLaundryCapacityEstimate(source.women, 'women'),
    };
}

function parseLaundryCapacityEstimate(
    value: unknown,
    expectedAccess: LaundryCapacityEstimate['access'],
): LaundryCapacityEstimate {
    const source = exactRecord(value, [
        'access', 'washerAvailable', 'projectedDryerSupply', 'pendingDryerLoads',
        'dryerHeadroom', 'startableLoads', 'reliable',
    ]);
    if (source.access !== expectedAccess) throw new Error('API_RESPONSE_INVALID');
    const washerAvailable = boundedLaundryCount(source.washerAvailable);
    const projectedDryerSupply = boundedLaundryCount(source.projectedDryerSupply);
    const pendingDryerLoads = boundedLaundryCount(source.pendingDryerLoads);
    const dryerHeadroom = boundedLaundryCount(source.dryerHeadroom);
    const reliable = boolean(source.reliable);
    const startableLoads = source.startableLoads === null
        ? null
        : boundedLaundryCount(source.startableLoads);
    if (dryerHeadroom !== Math.max(0, projectedDryerSupply - pendingDryerLoads)
        || reliable !== (startableLoads !== null)
        || (reliable && startableLoads !== Math.min(washerAvailable, dryerHeadroom))) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        access: expectedAccess,
        washerAvailable,
        projectedDryerSupply,
        pendingDryerLoads,
        dryerHeadroom,
        startableLoads,
        reliable,
    };
}

function parseLaundryAppliance(value: unknown): DashboardLaundryAppliance {
    const appliance = record(value);
    const projection = recordOrNull(appliance.projection);
    const kind = appliance.appliance;
    if (kind !== 'washer' && kind !== 'dryer') throw new Error('API_RESPONSE_INVALID');
    return {
        appliance: kind,
        operationalStatus: text(appliance.operationalStatus, 64),
        projection: projection ? {
            status: text(projection.status, 64),
            remainingMinutes: projection.remainingMinutes === null
                || projection.remainingMinutes === undefined
                ? undefined
                : finiteNumber(projection.remainingMinutes),
            estimated: projection.estimated === undefined ? undefined : boolean(projection.estimated),
        } : null,
        state: recordOrNull(appliance.state) as DashboardLaundryAppliance['state'],
        remainingMinutes: appliance.remainingMinutes === null
            ? null
            : finiteNumber(appliance.remainingMinutes),
        totalMinutes: appliance.totalMinutes === undefined ? undefined : finiteNumber(appliance.totalMinutes),
        startedAt: nullableIso(appliance.startedAt),
        estimatedFinishAt: nullableIso(appliance.estimatedFinishAt),
        observedAt: appliance.observedAt === undefined ? undefined : iso(appliance.observedAt),
        sessionId: nullableText(appliance.sessionId, 512),
        errorCode: nullableText(appliance.errorCode, 128),
    };
}

export function parseDashboardMealsSnapshot(
    value: unknown,
    expectedAssetOrigin: string | null = null,
): DashboardMealsSnapshot {
    const source = record(value);
    const data = record(source.data);
    if (data.schemaVersion !== 2) {
        throw new Error('API_RESPONSE_INVALID');
    }
    const currentWeeklyMenu = data.currentWeeklyMenu === null
        ? null
        : parseCurrentWeeklyMealMenu(data.currentWeeklyMenu, expectedAssetOrigin);
    return {
        asOf: iso(source.asOf),
        lastCheckedAt: nullableIso(source.lastCheckedAt),
        data: {
            schemaVersion: 2,
            dailyMenus: parseMealPosts(data.dailyMenus, 128, expectedAssetOrigin),
            pinnedMenus: parseMealPosts(data.pinnedMenus, 128, expectedAssetOrigin),
            recentMenus: parseMealPosts(data.recentMenus, 128, expectedAssetOrigin),
            currentWeeklyMenu,
            weeklyMenus: parseWeeklyMealMenus(data.weeklyMenus, expectedAssetOrigin),
        },
    };
}

export function parseDashboardMealHistoryMonth(
    value: unknown,
    expectedAssetOrigin: string | null = null,
): DashboardMealHistoryMonth {
    const source = exactRecord(value, ['posts']);
    return {
        posts: parseMealPosts(source.posts, 100, expectedAssetOrigin),
    };
}

function parseCurrentWeeklyMealMenu(
    value: unknown,
    expectedAssetOrigin: string | null,
): DashboardCurrentWeeklyMealMenu {
    const source = exactRecord(value, ['targetWeekKey', 'status', 'contentSha', 'post']);
    if (source.status !== 'AVAILABLE' && source.status !== 'AWAITING_UPDATE') {
        throw new Error('API_RESPONSE_INVALID');
    }
    const contentSha = source.contentSha === null ? null : mealSha(source.contentSha);
    const post = source.post === null ? null : parseMealPost(source.post, expectedAssetOrigin);
    if ((source.status === 'AVAILABLE') !== (contentSha !== null && post !== null)) {
        throw new Error('API_RESPONSE_INVALID');
    }
    if (post?.contentSha !== undefined && post.contentSha !== contentSha) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        targetWeekKey: mealWeekKey(source.targetWeekKey),
        status: source.status,
        contentSha,
        post,
    };
}

function parseWeeklyMealMenus(
    value: unknown,
    expectedAssetOrigin: string | null,
): DashboardWeeklyMealMenu[] {
    return array(value, 100).map((entry) => {
        const source = exactRecord(entry, ['weekKey', 'contentSha', 'post']);
        const weekKey = mealWeekKey(source.weekKey);
        const contentSha = mealSha(source.contentSha);
        const post = parseMealPost(source.post, expectedAssetOrigin);
        if (post.contentSha !== undefined && post.contentSha !== contentSha) {
            throw new Error('API_RESPONSE_INVALID');
        }
        return {weekKey, contentSha, post};
    });
}

function parseMealPosts(
    value: unknown,
    max = 128,
    expectedAssetOrigin: string | null = null,
): DashboardMealPost[] {
    return array(value, max).map((entry) => parseMealPost(entry, expectedAssetOrigin));
}

function parseMealPost(entry: unknown, expectedAssetOrigin: string | null): DashboardMealPost {
    const post = record(entry);
    const kind = post.kind;
    if (kind !== undefined && kind !== 'PINNED_MENU' && kind !== 'DAILY_MENU' && kind !== 'OTHER') {
        throw new Error('API_RESPONSE_INVALID');
    }
    const contentSha = post.contentSha === undefined ? undefined : mealSha(post.contentSha);
    const pinned = post.pinned === undefined ? undefined : boolean(post.pinned);
    const updatedAt = post.updatedAt === undefined ? undefined : nullableIso(post.updatedAt);
    const status = post.status === undefined ? undefined : nullableText(post.status, 128);
    const images = post.images === undefined
        ? undefined
        : parseMealImages(post.images, expectedAssetOrigin);
    const firstSeenAt = post.firstSeenAt === undefined ? undefined : iso(post.firstSeenAt);
    const lastSeenAt = post.lastSeenAt === undefined ? undefined : iso(post.lastSeenAt);
    return {
        id: text(post.id, 128),
        ...(kind === undefined ? {} : {kind}),
        ...(contentSha === undefined ? {} : {contentSha}),
        title: nullableText(post.title, 1_024),
        text: typeof post.text === 'string' && post.text.length <= 100_000
            ? post.text
            : (() => { throw new Error('API_RESPONSE_INVALID'); })(),
        ...(pinned === undefined ? {} : {pinned}),
        publishedAt: nullableIso(post.publishedAt),
        ...(updatedAt === undefined ? {} : {updatedAt}),
        permalink: safeMealPermalink(post.permalink),
        ...(status === undefined ? {} : {status}),
        ...(images === undefined ? {} : {images}),
        ...(firstSeenAt === undefined ? {} : {firstSeenAt}),
        ...(lastSeenAt === undefined ? {} : {lastSeenAt}),
    };
}

const MEAL_IMAGE_TYPES = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
} as const;

function parseMealImages(value: unknown, expectedAssetOrigin: string | null): DashboardMealImage[] {
    return array(value, 12).map((entry) => {
        const image = record(entry);
        const sha = mealSha(image.sha);
        const extension = text(image.extension, 8).toLowerCase() as keyof typeof MEAL_IMAGE_TYPES;
        const expectedContentType = MEAL_IMAGE_TYPES[extension];
        if (!expectedContentType || image.contentType !== expectedContentType) {
            throw new Error('API_RESPONSE_INVALID');
        }
        const width = nullableImageDimension(image.width);
        const height = nullableImageDimension(image.height);
        const byteLength = image.byteLength;
        if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1 || (byteLength as number) > 25_000_000) {
            throw new Error('API_RESPONSE_INVALID');
        }
        return {
            sha,
            url: safeMealAssetUrl(image.url, sha, extension, expectedAssetOrigin),
            contentType: expectedContentType,
            extension,
            width,
            height,
            byteLength: byteLength as number,
        };
    });
}

function nullableImageDimension(value: unknown): number | null {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20_000) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value as number;
}

function mealSha(value: unknown): string {
    const sha = text(value, 64);
    if (!/^[a-f0-9]{64}$/u.test(sha)) throw new Error('API_RESPONSE_INVALID');
    return sha;
}

function mealWeekKey(value: unknown): string {
    const key = calendarDate(value);
    if (new Date(`${key}T00:00:00.000Z`).getUTCDay() !== 1) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return key;
}

function safeMealAssetUrl(
    value: unknown,
    sha: string,
    extension: string,
    expectedOrigin: string | null,
): string {
    if (typeof value !== 'string' || value.length > 2_048) throw new Error('API_RESPONSE_INVALID');
    try {
        const parsed = new URL(value);
        const localHttp = parsed.protocol === 'http:'
            && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
        const expectedPath = `/api/public/assets/${sha}.${extension}`;
        if ((parsed.protocol !== 'https:' && !localHttp)
            || parsed.username
            || parsed.password
            || (expectedOrigin !== null && parsed.origin !== expectedOrigin)
            || parsed.pathname !== expectedPath
            || parsed.search
            || parsed.hash) {
            throw new Error('API_RESPONSE_INVALID');
        }
        return parsed.toString();
    } catch {
        throw new Error('API_RESPONSE_INVALID');
    }
}

export function safeMealPermalink(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2_048) return null;
    try {
        const parsed = new URL(value.replace(/^http:\/\//u, 'https://'));
        const safe = parsed.origin === 'https://pf.kakao.com'
            && !parsed.username
            && !parsed.password
            && /^\/_xhzNjn\/(?:posts|[1-9][0-9]*)$/u.test(parsed.pathname)
            && parsed.search === ''
            && parsed.hash === '';
        return safe ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function parseAttendancePayload(value: unknown, includesDevices: boolean): AttendanceData {
    const source = exactRecord(
        value,
        includesDevices ? ['attendance', 'freshness', 'devices'] : ['attendance', 'freshness'],
    );
    const freshness = attendanceFreshness(source.freshness);
    if (source.attendance === null) {
        if (freshness !== 'missing') throw new Error('API_RESPONSE_INVALID');
        return {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null};
    }
    if (source.attendance === undefined || freshness === 'missing') {
        throw new Error('API_RESPONSE_INVALID');
    }
    return attendanceFromSnapshot(source.attendance, freshness);
}

function attendanceFromSnapshot(value: unknown, freshnessValue: unknown): AttendanceData {
    const freshness = attendanceFreshness(freshnessValue);
    if (freshness === 'missing') throw new Error('API_RESPONSE_INVALID');
    const snapshot = parseAttendanceSnapshot(record(value));
    return {
        status: 'available',
        freshness,
        lastSyncedAt: snapshot.collectedAt,
        snapshot,
    };
}

function attendanceFreshness(value: unknown): 'fresh' | 'stale' | 'missing' {
    if (value !== 'fresh' && value !== 'stale' && value !== 'missing') {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function parseAttendanceSnapshot(snapshot: Record<string, unknown>): AttendanceSnapshot {
    const source = exactRecord(snapshot, [
        'attendanceDate', 'cohortId', 'cohortStatus', 'cohortStartDate', 'cohortEndDate',
        'morningChecked', 'eveningChecked', 'collectedAt',
    ]);
    const attendanceDate = calendarDate(source.attendanceDate);
    const cohortId = nullableText(source.cohortId, 128);
    const cohortStatus = text(source.cohortStatus, 32);
    const cohortStartDate = nullableCalendarDate(source.cohortStartDate);
    const cohortEndDate = nullableCalendarDate(source.cohortEndDate);
    const morningChecked = boolean(source.morningChecked);
    const eveningChecked = boolean(source.eveningChecked);
    if (!ATTENDANCE_COHORT_STATUSES.has(cohortStatus)
        || (cohortStartDate !== null && cohortEndDate !== null && cohortStartDate > cohortEndDate)
        || (cohortStatus === 'active' && cohortId === null)
        || ((cohortStatus === 'upcoming' || cohortStatus === 'ended')
            && (cohortId !== null || morningChecked || eveningChecked))
        || (cohortStatus === 'none'
            && (cohortId !== null || cohortStartDate !== null || cohortEndDate !== null
                || morningChecked || eveningChecked))
        || (cohortStatus === 'unknown' && cohortId !== null)) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        attendanceDate,
        cohortId,
        cohortStatus,
        cohortStartDate,
        cohortEndDate,
        morningChecked,
        eveningChecked,
        collectedAt: iso(source.collectedAt),
    };
}

function parseDevices(value: unknown): DesktopDevice[] {
    return array(value, 32).map((entry) => {
        const device = exactRecord(entry, [
            'id', 'deviceLabel', 'lastSeenAt', 'lmsSessionState', 'health', 'appVersion',
        ]);
        const lms = device.lmsSessionState;
        const health = device.health;
        if (lms !== 'unknown' && lms !== 'connected' && lms !== 'login-required') {
            throw new Error('API_RESPONSE_INVALID');
        }
        if (health !== 'unknown' && health !== 'online' && health !== 'offline') {
            throw new Error('API_RESPONSE_INVALID');
        }
        return {
            id: text(device.id, 128),
            deviceLabel: nullableText(device.deviceLabel, 80),
            lastSeenAt: nullableIso(device.lastSeenAt),
            lmsSessionState: lms,
            health,
            appVersion: nullableText(device.appVersion, 64),
        };
    });
}

function parseDesktopConnection(value: unknown): DesktopConnectionState {
    const source = exactRecord(value, [
        'authenticated', 'credentialPersistent', 'identityResetRequired',
        'lmsSessionState', 'lastServerContact', 'lastError',
    ]);
    const authenticated = boolean(source.authenticated);
    const identityResetRequired = boolean(source.identityResetRequired);
    const lmsSessionState = source.lmsSessionState;
    if (lmsSessionState !== 'unknown' && lmsSessionState !== 'connected' && lmsSessionState !== 'login-required') {
        throw new Error('API_RESPONSE_INVALID');
    }
    const credentialPersistent = boolean(source.credentialPersistent);
    nullableText(source.lastError, 128);
    const lastContact = nullableIso(source.lastServerContact);
    return {
        state: identityResetRequired ? 'reset-required' : authenticated ? 'connected' : 'disconnected',
        credentialPersistent,
        lastVerifiedAt: lastContact,
        lastSeenAt: lastContact,
        health: authenticated ? (source.lastError === null ? 'online' : 'unknown') : null,
        lmsSessionState,
    };
}

function parsePairingCreated(value: unknown): MobilePairingCreated {
    const source = exactRecord(value, ['pairingId', 'qrPayload', 'manualCode', 'expiresAt']);
    const pairingId = text(source.pairingId, 64);
    const manualCode = normalizeManualPairingCode(text(source.manualCode, 32));
    assertIdentifier(pairingId, PAIRING_ID);
    if (!/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(manualCode)) throw new Error('API_RESPONSE_INVALID');
    return {
        pairingId,
        qrPayload: text(source.qrPayload, 4_096),
        manualCode,
        expiresAt: iso(source.expiresAt),
    };
}

function parsePairingClaim(value: unknown): PairingClaim {
    const source = exactRecord(value, ['claimId', 'status']);
    const claimId = text(source.claimId, 64);
    assertIdentifier(claimId, CLAIM_ID);
    if (source.status !== 'awaiting-desktop-approval') throw new Error('API_RESPONSE_INVALID');
    return {claimId, status: source.status};
}

function parsePairingStatus(value: unknown): MobilePairingStatus {
    const source = exactRecord(value, ['status', 'claim']);
    const status = source.status;
    if (status !== 'pending'
        && status !== 'claimed'
        && status !== 'approved'
        && status !== 'completed'
        && status !== 'expired') {
        throw new Error('API_RESPONSE_INVALID');
    }
    if (status !== 'claimed') {
        if (source.claim !== null && source.claim !== undefined) throw new Error('API_RESPONSE_INVALID');
        return {status, claim: null};
    }
    if (source.claim === null || source.claim === undefined) throw new Error('API_RESPONSE_INVALID');
    const claim = exactRecord(source.claim, ['claimId', 'deviceLabel', 'confirmationCode']);
    const confirmationCode = text(claim.confirmationCode, 4);
    if (!/^[A-Za-z0-9]{4}$/u.test(confirmationCode)) throw new Error('API_RESPONSE_INVALID');
    return {
        status,
        claim: {
            claimId: validatedIdentifier(text(claim.claimId, 64), CLAIM_ID),
            deviceLabel: text(claim.deviceLabel, 80),
            confirmationCode,
        },
    };
}

function parseMobileSessions(value: unknown): MobileSession[] {
    const source = exactRecord(value, ['devices']);
    return array(source.devices).map((entry) => {
        const session = exactRecord(entry, [
            'deviceId', 'deviceLabel', 'installationId', 'createdAt', 'expiresAt',
            'lastSeenAt', 'pushEnabled', 'status',
        ]);
        const status = session.status;
        if (status !== 'active' && status !== 'revoked' && status !== 'expired') {
            throw new Error('API_RESPONSE_INVALID');
        }
        const deviceId = validatedIdentifier(text(session.deviceId, 64), MOBILE_SESSION_ID);
        const installationId = validatedIdentifier(
            text(session.installationId, 37),
            MOBILE_INSTALLATION_ID,
        );
        const createdAt = iso(session.createdAt);
        const expiresAt = iso(session.expiresAt);
        const lastSeenAt = iso(session.lastSeenAt);
        if (Date.parse(expiresAt) <= Date.parse(createdAt)
            || Date.parse(lastSeenAt) < Date.parse(createdAt)) {
            throw new Error('API_RESPONSE_INVALID');
        }
        return {
            deviceId,
            deviceLabel: text(session.deviceLabel, 80),
            installationId,
            createdAt,
            expiresAt,
            lastSeenAt,
            pushEnabled: boolean(session.pushEnabled),
            status,
        };
    });
}

function parseNotifications(value: unknown): DashboardNotification[] {
    return array(value).map((entry) => {
        const item = exactRecord(entry, [
            'id', 'kind', 'title', 'body', 'path', 'createdAtEpochMs',
            'expiresAtEpochMs', 'attempt',
        ]);
        const path = text(item.path, 128);
        if (!/^\/dashboard\.html#(?:attendance|laundry|meals|notifications|connections)$/u.test(path)) {
            throw new Error('API_RESPONSE_INVALID');
        }
        const createdAtEpochMs = safeEpochMillis(item.createdAtEpochMs);
        const expiresAtEpochMs = safeEpochMillis(item.expiresAtEpochMs);
        const attempt = safeEpochMillis(item.attempt);
        if (expiresAtEpochMs < createdAtEpochMs || attempt > 1_000) {
            throw new Error('API_RESPONSE_INVALID');
        }
        const kind = text(item.kind, 128);
        if (!NOTIFICATION_KINDS.has(kind)) throw new Error('API_RESPONSE_INVALID');
        return {
            id: validatedIdentifier(text(item.id, 36), UUID_IDENTIFIER),
            kind,
            title: text(item.title, 256),
            body: text(item.body, 2_048),
            path,
            createdAtEpochMs,
            expiresAtEpochMs,
            attempt,
        };
    });
}

function validMobileClaimIdentity(deviceLabel: string, installationId: string): boolean {
    return typeof deviceLabel === 'string'
        && deviceLabel.trim() === deviceLabel
        && deviceLabel.length >= 1
        && deviceLabel.length <= 80
        && MOBILE_INSTALLATION_ID.test(installationId);
}

function assertIdentifier(value: string, pattern: RegExp, clientArgument = false): void {
    if (!pattern.test(value)) {
        throw new Error(clientArgument ? 'API_CLIENT_INVALID_ARGUMENT' : 'API_RESPONSE_INVALID');
    }
}

function validatedIdentifier(value: string, pattern: RegExp): string {
    assertIdentifier(value, pattern);
    return value;
}
