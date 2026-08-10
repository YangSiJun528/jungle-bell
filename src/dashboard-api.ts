import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {
    normalizeManualPairingCode,
    type DashboardLaundryMachine,
    type LaundryCapacityEstimate,
    type LaundryCapacitySnapshot,
} from './dashboard-model';
import {
    normalizeNotificationInboxSnapshot,
    type NotificationInboxSnapshot,
} from './notification-inbox';

export type DashboardFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type DashboardInvoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

export interface DashboardApiOptions {
    campusApiBaseUrl?: string;
    platformApiBaseUrl?: string;
    fetcher?: DashboardFetch;
    invokeCommand?: DashboardInvoke;
    authorizationProvider?: () => string | null;
    desktopRuntime?: boolean;
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
    };
    machines: DashboardLaundryMachine[];
    capacity: LaundryCapacitySnapshot | null;
}

export interface DashboardMealPost {
    id: string;
    title: string | null;
    text: string;
    publishedAt: string | null;
    permalink: string | null;
}

export interface DashboardMealsSnapshot {
    asOf: string;
    lastCheckedAt: string | null;
    data: {
        dailyMenus: DashboardMealPost[];
        pinnedMenus: DashboardMealPost[];
        recentMenus: DashboardMealPost[];
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
    sourceDeviceId: string;
    version: number;
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
    state: 'disconnected' | 'unknown' | 'connected' | 'expiring' | 'expired';
    desktopId: string | null;
    lastVerifiedAt: string | null;
    lastSeenAt: string | null;
    health: 'unknown' | 'online' | 'offline' | null;
}

export interface MobilePairingCreated {
    pairingId: string;
    qrPayload: string;
    manualCode: string;
    expiresAt: string;
}

export interface PairingClaim {
    claimId: string;
    claimReceipt: string;
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
    sessionId: string;
    deviceId: string;
    deviceLabel: string;
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

export interface DashboardApi {
    getPublicLaundry(): Promise<DashboardLaundrySnapshot>;
    getPublicMeals(): Promise<DashboardMealsSnapshot>;
    getAttendance(surface: 'desktop' | 'companion'): Promise<AttendanceDashboard>;
    probeMobileSession(): Promise<boolean>;
    getDesktopConnectionState(): Promise<DesktopConnectionState>;
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
    completePairing(pairingId: string, claim: PairingClaim): Promise<'waiting' | 'completed'>;
    disconnectMobileSession(): Promise<void>;
    getNotifications(): Promise<DashboardNotification[]>;
    getDesktopNotificationInbox(): Promise<NotificationInboxSnapshot>;
    activateDesktopNotification(id: string): Promise<NotificationInboxSnapshot>;
    sendDesktopTestNotification(): Promise<DesktopTestNotificationResult>;
    sendMobileTestNotification(): Promise<number>;
    getPushPublicKey(): Promise<string>;
    registerPushSubscription(subscription: PushSubscriptionJSON): Promise<void>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PAIRING_ID = new RegExp(`^jbp_${UUID}$`, 'u');
const CLAIM_ID = new RegExp(`^jbp_${UUID}$`, 'u');
const CLAIM_RECEIPT = /^jbcr_[0-9a-f]{64}$/u;
const PAIRING_CHALLENGE = /^jbpc_[0-9a-f]{64}$/u;

export function createDashboardApi(options: DashboardApiOptions = {}): DashboardApi {
    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const invokeCommand = options.invokeCommand
        ?? ((command, args) => tauriInvoke(command, args));
    const desktopRuntime = options.desktopRuntime
        ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
    const configuredCampusBase = options.campusApiBaseUrl
        ?? import.meta.env.VITE_CAMPUS_API_URL
        ?? '';
    const campusBase = normalizeBaseUrl(configuredCampusBase);
    const platformBase = normalizeBaseUrl(
        options.platformApiBaseUrl
            ?? import.meta.env.VITE_PLATFORM_API_URL
            ?? configuredCampusBase,
    );

    const publicJson = async (path: string): Promise<unknown> => {
        const response = await fetcher(apiUrl(campusBase, path), {
            method: 'GET',
            credentials: 'omit',
            headers: {accept: 'application/json'},
        });
        return responseJson(response);
    };

    const privateResponse = (path: string, init: RequestInit = {}): Promise<Response> => {
        const authorization = options.authorizationProvider?.() ?? null;
        return fetcher(apiUrl(platformBase, path), {
            ...init,
            credentials: 'include',
            cache: 'no-store',
            headers: {
                accept: 'application/json',
                ...(init.body === undefined ? {} : {'content-type': 'application/json'}),
                ...(authorization ? {authorization} : {}),
                ...init.headers,
            },
        });
    };

    const privateJson = async (path: string, init: RequestInit = {}): Promise<unknown> =>
        responseJson(await privateResponse(path, init));

    const privateNoContent = async (path: string, init: RequestInit): Promise<void> => {
        const response = await privateResponse(path, init);
        if (!response.ok) throw await responseError(response);
        if (response.status !== 204 && response.status !== 200) throw new Error('API_RESPONSE_INVALID');
    };

    return {
        async getPublicLaundry() {
            const value = desktopRuntime
                ? await invokeCommand('get_dashboard_campus_data', {kind: 'laundry'})
                : await publicJson('/v1/laundry/latest');
            return parseDashboardLaundrySnapshot(value);
        },

        async getPublicMeals() {
            const value = desktopRuntime
                ? await invokeCommand('get_dashboard_campus_data', {kind: 'meals'})
                : await publicJson('/v1/meals');
            return parseMeals(value);
        },

        async getAttendance(surface) {
            if (surface === 'desktop') {
                return parseAttendanceDashboard(await invokeCommand('get_remote_attendance_snapshot'));
            }
            const response = await privateResponse('/v1/attendance/snapshots', {method: 'GET'});
            if (response.status === 401) return {state: 'auth-required'};
            const attendanceValue = await responseJson(response);
            const attendanceRecord = recordOrNull(attendanceValue);
            if (attendanceRecord?.state === 'auth-required') return {state: 'auth-required'};
            if (attendanceRecord && Array.isArray(attendanceRecord.devices)) {
                return parseAttendanceDashboard(attendanceRecord);
            }
            return {
                state: 'loaded',
                attendance: parseAttendancePayload(attendanceValue),
                devices: [],
            };
        },

        async probeMobileSession() {
            const response = await privateResponse('/v1/mobile/session', {method: 'GET'});
            if (response.status === 401 || response.status === 404) return false;
            if (!response.ok) throw await responseError(response);
            return true;
        },

        async getDesktopConnectionState() {
            return parseDesktopConnection(await invokeCommand('get_connected_service_status'));
        },

        async refreshPlatformSync() {
            await invokeCommand('refresh_platform_sync');
        },

        async openLmsLogin() {
            await invokeCommand('open_lms_login');
        },

        async createMobilePairing() {
            return parsePairingCreated(await invokeCommand('create_mobile_pairing'));
        },

        async getMobilePairingStatus(pairingId) {
            assertIdentifier(pairingId, PAIRING_ID);
            return parsePairingStatus(await invokeCommand('get_mobile_pairing_status', {pairingId}));
        },

        async approveMobilePairing(pairingId, claimId) {
            assertIdentifier(pairingId, PAIRING_ID);
            assertIdentifier(claimId, CLAIM_ID);
            await invokeCommand('approve_mobile_pairing', {pairingId, claimId});
        },

        async listMobileSessions() {
            const value = await invokeCommand('list_mobile_sessions');
            const sessions = Array.isArray(value) ? value : record(value).sessions;
            return parseMobileSessions(sessions);
        },

        async revokeMobileSession(deviceId) {
            if (!deviceId || deviceId.length > 128) throw new Error('API_CLIENT_INVALID_ARGUMENT');
            await invokeCommand('revoke_mobile_session', {deviceId});
        },

        async claimManualPairing(input) {
            const manualCode = normalizeManualPairingCode(input.manualCode);
            if (!/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(manualCode)) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            return parsePairingClaim(await privateJson('/v1/pairing-claims', {
                method: 'POST',
                body: JSON.stringify({
                    manualCode,
                    installationId: input.installationId,
                    deviceLabel: input.deviceLabel,
                }),
            }));
        },

        async claimQrPairing(input) {
            assertIdentifier(input.pairingId, PAIRING_ID);
            if (!PAIRING_CHALLENGE.test(input.challenge)) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            return parsePairingClaim(await privateJson(
                `/v1/pairings/${encodeURIComponent(input.pairingId)}/claims`,
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

        async completePairing(pairingId, claim) {
            assertIdentifier(pairingId, PAIRING_ID);
            assertIdentifier(claim.claimId, CLAIM_ID);
            assertIdentifier(claim.claimReceipt, CLAIM_RECEIPT);
            const response = await privateResponse(`/v1/pairings/${encodeURIComponent(pairingId)}/complete`, {
                method: 'POST',
                body: JSON.stringify({
                    claimId: claim.claimId,
                    claimReceipt: claim.claimReceipt,
                }),
            });
            if (response.status === 409) {
                const value = await safeJson(response);
                if (recordOrNull(value)?.error === 'PAIRING_NOT_APPROVED') return 'waiting';
            }
            if (!response.ok) throw await responseError(response);
            return 'completed';
        },

        async disconnectMobileSession() {
            await privateNoContent('/v1/mobile/session', {method: 'DELETE'});
        },

        async getNotifications() {
            const value = await privateJson('/v1/notifications/inbox?limit=20', {method: 'GET'});
            const source = record(value);
            const items = Array.isArray(value)
                ? value
                : source.notifications ?? source.items;
            return parseNotifications(items);
        },

        async getDesktopNotificationInbox() {
            const snapshot = normalizeNotificationInboxSnapshot(
                await invokeCommand('get_notification_inbox_snapshot'),
            );
            if (!snapshot) throw new Error('API_RESPONSE_INVALID');
            return snapshot;
        },

        async activateDesktopNotification(id) {
            if (!/^\d+$/u.test(id)) throw new Error('API_CLIENT_INVALID_ARGUMENT');
            const snapshot = normalizeNotificationInboxSnapshot(
                await invokeCommand('activate_notification', {id}),
            );
            if (!snapshot) throw new Error('API_RESPONSE_INVALID');
            return snapshot;
        },

        async sendDesktopTestNotification() {
            const value = record(await invokeCommand('send_test_notification'));
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
            const value = record(await privateJson('/v1/notifications/test', {
                method: 'POST',
                body: JSON.stringify({}),
            }));
            if (!Number.isSafeInteger(value.queued) || (value.queued as number) < 1) {
                throw new Error('API_RESPONSE_INVALID');
            }
            text(value.notificationId, 128);
            return value.queued as number;
        },

        async getPushPublicKey() {
            const value = record(await privateJson('/v1/push/vapid-public-key', {method: 'GET'}));
            return text(value.publicKey, 512);
        },

        async registerPushSubscription(subscription) {
            const keys = subscription.keys;
            if (!subscription.endpoint || !keys?.p256dh || !keys.auth) {
                throw new Error('API_CLIENT_INVALID_ARGUMENT');
            }
            await privateJson('/v1/push/subscriptions', {
                method: 'PUT',
                body: JSON.stringify({
                    endpoint: subscription.endpoint,
                    keys: {p256dh: keys.p256dh, auth: keys.auth},
                }),
            });
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

function apiUrl(base: string, path: string): string {
    return base ? `${base}${path}` : path;
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

function text(value: unknown, max = 512): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return value;
}

function nullableText(value: unknown, max = 512): string | null {
    return value === null || value === undefined ? null : text(value, max);
}

function boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('API_RESPONSE_INVALID');
    return value;
}

function finiteNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('API_RESPONSE_INVALID');
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
    return value === null || value === undefined ? null : iso(value);
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
    return {
        schemaVersion: finiteNumber(source.schemaVersion),
        asOf: iso(source.asOf),
        final: boolean(source.final),
        quality: {
            collection: text(quality.collection, 64),
            sourceFreshness: text(quality.sourceFreshness, 64),
            lastCheckedAt: nullableIso(quality.lastCheckedAt),
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
    const source = record(value);
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
    const source = record(value);
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

function parseMeals(value: unknown): DashboardMealsSnapshot {
    const source = record(value);
    const data = record(source.data);
    const recent = data.recentMenus ?? data.otherPosts ?? [];
    return {
        asOf: iso(source.asOf),
        lastCheckedAt: nullableIso(source.lastCheckedAt),
        data: {
            dailyMenus: parseMealPosts(data.dailyMenus),
            pinnedMenus: parseMealPosts(data.pinnedMenus),
            recentMenus: parseMealPosts(recent),
        },
    };
}

function parseMealPosts(value: unknown): DashboardMealPost[] {
    return array(value).map((entry) => {
        const post = record(entry);
        return {
            id: text(post.id, 128),
            title: nullableText(post.title, 1_024),
            text: typeof post.text === 'string' && post.text.length <= 100_000
                ? post.text
                : (() => { throw new Error('API_RESPONSE_INVALID'); })(),
            publishedAt: nullableIso(post.publishedAt),
            permalink: safeMealPermalink(post.permalink),
        };
    });
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

function parseAttendanceDashboard(value: unknown): AttendanceDashboard {
    const source = record(value);
    if (source.state === 'auth-required') return {state: 'auth-required'};
    const attendance = parseAttendancePayload(source);
    const devices = source.devices === undefined ? [] : parseDevices(source.devices);
    return {state: 'loaded', attendance, devices};
}

function parseAttendancePayload(value: unknown): AttendanceData {
    const source = record(value);
    if (Object.prototype.hasOwnProperty.call(source, 'attendance')) {
        const freshness = attendanceFreshness(source.freshness);
        if (source.attendance === null) {
            if (freshness !== 'missing') throw new Error('API_RESPONSE_INVALID');
            return {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null};
        }
        if (freshness === 'missing') throw new Error('API_RESPONSE_INVALID');
        return attendanceFromSnapshot(source.attendance, freshness);
    }
    if (source.latest !== undefined) {
        const freshness = attendanceFreshness(source.freshness);
        if (source.latest === null) {
            if (freshness !== 'missing') throw new Error('API_RESPONSE_INVALID');
            return {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null};
        }
        if (freshness === 'missing') throw new Error('API_RESPONSE_INVALID');
        return attendanceFromSnapshot(source.latest, freshness);
    }
    if (Array.isArray(source.snapshots)) {
        const latest = source.snapshots[0];
        const freshness = attendanceFreshness(source.freshness);
        if (latest === undefined) {
            if (freshness !== 'missing') throw new Error('API_RESPONSE_INVALID');
            return {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null};
        }
        if (freshness === 'missing') throw new Error('API_RESPONSE_INVALID');
        return attendanceFromSnapshot(latest, freshness);
    }
    if (source.morningChecked !== undefined && source.eveningChecked !== undefined) {
        const freshness = attendanceFreshness(source.freshness);
        if (freshness === 'missing') throw new Error('API_RESPONSE_INVALID');
        return attendanceFromSnapshot(source, freshness);
    }
    return parseAttendance(source);
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

function parseAttendance(value: unknown): AttendanceData {
    const source = record(value);
    if (source.status === 'unavailable') {
        return {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null};
    }
    if (source.status !== 'available' || (source.freshness !== 'fresh' && source.freshness !== 'stale')) {
        throw new Error('API_RESPONSE_INVALID');
    }
    const snapshot = record(source.snapshot);
    return {
        status: 'available',
        freshness: source.freshness,
        lastSyncedAt: iso(source.lastSyncedAt),
        snapshot: parseAttendanceSnapshot(snapshot),
    };
}

function parseAttendanceSnapshot(snapshot: Record<string, unknown>): AttendanceSnapshot {
    return {
        attendanceDate: text(snapshot.attendanceDate, 10),
        cohortId: nullableText(snapshot.cohortId, 256),
        cohortStatus: snapshot.cohortStatus === undefined
            ? 'unknown'
            : text(snapshot.cohortStatus, 32),
        cohortStartDate: nullableText(snapshot.cohortStartDate, 10),
        cohortEndDate: nullableText(snapshot.cohortEndDate, 10),
        morningChecked: boolean(snapshot.morningChecked),
        eveningChecked: boolean(snapshot.eveningChecked),
        collectedAt: iso(snapshot.collectedAt),
        sourceDeviceId: snapshot.sourceDeviceId === undefined
            ? 'unknown'
            : text(snapshot.sourceDeviceId, 128),
        version: snapshot.version === undefined ? 0 : finiteNumber(snapshot.version),
    };
}

function parseDevices(value: unknown): DesktopDevice[] {
    return array(value, 32).map((entry) => {
        const device = record(entry);
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
    const source = record(value);
    if (typeof source.authenticated === 'boolean') {
        return {
            state: source.authenticated ? 'connected' : 'disconnected',
            desktopId: nullableText(source.installationId, 128),
            lastVerifiedAt: nullableIso(source.lastServerContact),
            lastSeenAt: nullableIso(source.lastServerContact),
            health: source.authenticated
                ? (source.lastError === null || source.lastError === undefined ? 'online' : 'unknown')
                : null,
        };
    }
    const state = source.state;
    const health = source.health;
    if (!['disconnected', 'unknown', 'connected', 'expiring', 'expired'].includes(String(state))) {
        throw new Error('API_RESPONSE_INVALID');
    }
    if (health !== null && health !== undefined && !['unknown', 'online', 'offline'].includes(String(health))) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        state: state as DesktopConnectionState['state'],
        desktopId: nullableText(source.desktopId, 128),
        lastVerifiedAt: nullableIso(source.lastVerifiedAt),
        lastSeenAt: nullableIso(source.lastSeenAt),
        health: (health ?? null) as DesktopConnectionState['health'],
    };
}

function parsePairingCreated(value: unknown): MobilePairingCreated {
    const source = record(value);
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
    const source = record(value);
    const claimId = text(source.claimId, 64);
    const claimReceipt = text(source.claimReceipt, 128);
    assertIdentifier(claimId, CLAIM_ID);
    assertIdentifier(claimReceipt, CLAIM_RECEIPT);
    if (source.status !== 'awaiting-desktop-approval') throw new Error('API_RESPONSE_INVALID');
    return {claimId, claimReceipt, status: source.status};
}

function parsePairingStatus(value: unknown): MobilePairingStatus {
    const source = record(value);
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
    const claim = record(source.claim);
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
    return array(value).map((entry) => {
        const session = record(entry);
        const status = session.status;
        if (status !== 'active' && status !== 'revoked' && status !== 'expired') {
            throw new Error('API_RESPONSE_INVALID');
        }
        const deviceId = text(session.deviceId, 128);
        const sessionId = session.sessionId === undefined
            ? deviceId
            : text(session.sessionId, 64);
        return {
            sessionId,
            deviceId,
            deviceLabel: text(session.deviceLabel, 80),
            createdAt: iso(session.createdAt),
            expiresAt: iso(session.expiresAt),
            lastSeenAt: iso(session.lastSeenAt),
            pushEnabled: boolean(session.pushEnabled),
            status,
        };
    });
}

function parseNotifications(value: unknown): DashboardNotification[] {
    return array(value).map((entry) => {
        const item = record(entry);
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
        return {
            id: text(item.id, 128),
            kind: text(item.kind, 128),
            title: text(item.title, 256),
            body: text(item.body, 2_048),
            path,
            createdAtEpochMs,
            expiresAtEpochMs,
            attempt,
        };
    });
}

function assertIdentifier(value: string, pattern: RegExp): void {
    if (!pattern.test(value)) throw new Error('API_RESPONSE_INVALID');
}

function validatedIdentifier(value: string, pattern: RegExp): string {
    assertIdentifier(value, pattern);
    return value;
}
