import {z, type ZodType} from 'zod';
import type {NotificationInboxSnapshot} from '@/domain/notifications/inbox';
import type {
    DesktopSettingsAdapter,
    PlatformAdapter,
} from '@/platform/contracts';
import {platformApiBaseUrl} from '@/platform/build-config';
import {
    parseInput,
    responseJson,
    responseNoContent,
    responseValue,
    safeResponseJson,
} from './api-response';
import {
    browserAccountSessionSchema,
    claimIdSchema,
    dashboardNotificationsSchema,
    manualPairingClaimInputSchema,
    mobilePairingCreatedSchema,
    mobilePairingStatusSchema,
    mobileSessionIdSchema,
    mobileSessionsSchema,
    mobileTestNotificationResultSchema,
    notificationInboxIdSchema,
    pairingHandoffClaimInputSchema,
    pairingClaimSchema,
    pairingIdSchema,
    parseAttendanceDashboardPayload,
    parseDesktopConnection,
    parseDesktopTestNotificationResult,
    parseNotificationInboxSnapshot,
    pushPublicKeyResultSchema,
    pushSubscriptionInputSchema,
    pushSubscriptionResultSchema,
    qrPairingClaimInputSchema,
    qrPairingHandoffInputSchema,
    type AttendanceData,
    type BrowserAccountSession,
    type DashboardNotification,
    type DesktopConnectionState,
    type DesktopDevice,
    type DesktopTestNotificationResult,
    type MobilePairingCreated,
    type MobilePairingStatus,
    type MobileSession,
    type PairingClaim,
} from './dashboard-account-contract';
import {
    parseDashboardLaundrySnapshot,
    parseDashboardMealHistoryMonth,
    parseDashboardMealsSnapshot,
    safeMealPermalink,
    type DashboardCurrentWeeklyMealMenu,
    type DashboardLaundryAppliance,
    type DashboardLaundrySnapshot,
    type DashboardMealHistoryMonth,
    type DashboardMealImage,
    type DashboardMealPost,
    type DashboardMealsSnapshot,
    type DashboardWeeklyMealMenu,
} from './dashboard-campus-contract';
import {
    createHttpApiClient,
    type AccountApiPath,
    type PairingApiPath,
} from './http-api-client';
import {
    createDashboardPersonalApi,
    type DashboardPersonalApi,
} from './personal-api';

export type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryNotificationMode,
    LaundryWatch,
    LaundryWatchInput,
    MealPreferences,
    MealPreferencesInput,
} from './personal-api';
export type {
    AttendanceData,
    AttendanceSnapshot,
    BrowserAccountSession,
    DashboardNotification,
    DesktopConnectionState,
    DesktopDevice,
    DesktopTestNotificationResult,
    MobilePairingCreated,
    MobilePairingStatus,
    MobileSession,
    PairingClaim,
} from './dashboard-account-contract';
export type {
    DashboardCurrentWeeklyMealMenu,
    DashboardLaundryAppliance,
    DashboardLaundrySnapshot,
    DashboardMealHistoryMonth,
    DashboardMealImage,
    DashboardMealPost,
    DashboardMealsSnapshot,
    DashboardWeeklyMealMenu,
} from './dashboard-campus-contract';
export {
    parseDashboardLaundrySnapshot,
    parseDashboardMealHistoryMonth,
    parseDashboardMealsSnapshot,
    safeMealPermalink,
};

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

export type AttendanceDashboard =
    | {state: 'auth-required'}
    | {state: 'loaded'; attendance: AttendanceData; devices: DesktopDevice[]};

export interface DashboardApi extends DashboardPersonalApi, DesktopSettingsAdapter {
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
    prepareQrPairingHandoff(input: {
        pairingId: string;
        challenge: string;
    }): Promise<void>;
    claimPairingHandoff(input: {
        deviceLabel: string;
        installationId: string;
    }): Promise<PairingClaim | null>;
    completePairing(pairingId: string): Promise<'waiting' | 'completed'>;
    getAccountSession(): Promise<BrowserAccountSession | null>;
    disconnectMobileSession(): Promise<void>;
    getNotifications(): Promise<DashboardNotification[]>;
    getDesktopNotificationInbox(): Promise<NotificationInboxSnapshot>;
    markDesktopNotificationRead(id: string): Promise<NotificationInboxSnapshot>;
    markAllDesktopNotificationsRead(): Promise<NotificationInboxSnapshot>;
    activateDesktopNotification(id: string): Promise<NotificationInboxSnapshot>;
    sendDesktopTestNotification(): Promise<DesktopTestNotificationResult>;
    sendMobileTestNotification(): Promise<number>;
    getPushPublicKey(): Promise<string>;
    registerPushSubscription(subscription: PushSubscriptionJSON): Promise<void>;
}

const historyMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const pairingWaitingErrorSchema = z.looseObject({
    error: z.literal('PAIRING_NOT_APPROVED'),
});

export function createDashboardApi(options: DashboardApiOptions = {}): DashboardApi {
    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const platform = options.platformAdapter;
    if (!platform) throw new Error('PLATFORM_ADAPTER_REQUIRED');

    const nativeBridge = platform.native;
    const adapterApiBase = platformApiBaseUrl;
    const campusBase = normalizeBaseUrl(options.campusApiBaseUrl ?? adapterApiBase);
    const pageOrigin = typeof window !== 'undefined' && /^https?:$/u.test(window.location.protocol)
        ? window.location.origin
        : null;
    const mealAssetOrigin = campusBase || (platform.kind === 'browser' ? pageOrigin : null);
    const platformBase = normalizeBaseUrl(options.platformApiBaseUrl ?? adapterApiBase);
    const desktopSession = platform.accountAuthentication.kind === 'desktop-session'
        ? platform.accountAuthentication.session
        : undefined;
    const httpClient = createHttpApiClient({
        fetcher,
        publicBase: campusBase,
        platformBase,
        accountAuthentication: platform.accountAuthentication,
    });

    const publicJson = async (path: `/api/public/${string}`): Promise<unknown> =>
        responseJson(await httpClient.publicResponse(path, {method: 'GET'}));

    const pairingResponse = (path: PairingApiPath, init: RequestInit = {}): Promise<Response> =>
        httpClient.pairingResponse(path, init);

    const accountResponse = (path: AccountApiPath, init: RequestInit = {}): Promise<Response> =>
        httpClient.accountResponse(path, init);

    const pairingValue = async <T>(
        schema: ZodType<T>,
        path: PairingApiPath,
        init: RequestInit,
    ): Promise<T> => responseValue(schema, await pairingResponse(path, init));

    const accountValue = async <T>(
        schema: ZodType<T>,
        path: AccountApiPath,
        init: RequestInit = {},
    ): Promise<T> => responseValue(schema, await accountResponse(path, init));

    const accountNoContent = async (path: AccountApiPath, init: RequestInit): Promise<void> =>
        responseNoContent(await accountResponse(path, init));

    const personalApi = createDashboardPersonalApi({httpClient});

    return {
        ...personalApi,
        ...platform.desktopSettings,

        async getPublicLaundry() {
            return parseDashboardLaundrySnapshot(await publicJson('/api/public/laundry'));
        },

        async getPublicMeals() {
            return parseDashboardMealsSnapshot(
                await publicJson('/api/public/meals'),
                mealAssetOrigin,
            );
        },

        async getPublicMealHistoryMonth(month) {
            const parsedMonth = parseInput(historyMonthSchema, month);
            return parseDashboardMealHistoryMonth(
                await publicJson(`/api/public/meals/history?month=${parsedMonth}`),
                mealAssetOrigin,
            );
        },

        async getAttendance() {
            const response = await accountResponse('/api/me/attendance', {method: 'GET'});
            if (response.status === 401) return {state: 'auth-required'};
            return {
                state: 'loaded',
                ...parseAttendanceDashboardPayload(await responseJson(response)),
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
            return accountValue(mobilePairingCreatedSchema, '/api/me/pairings', {
                method: 'POST',
                body: JSON.stringify({}),
            });
        },

        async getMobilePairingStatus(pairingId) {
            const id = parseInput(pairingIdSchema, pairingId);
            return accountValue(
                mobilePairingStatusSchema,
                `/api/me/pairings/${encodeURIComponent(id)}`,
                {method: 'GET'},
            );
        },

        async approveMobilePairing(pairingId, claimId) {
            const id = parseInput(pairingIdSchema, pairingId);
            const claim = parseInput(claimIdSchema, claimId);
            await accountNoContent(`/api/me/pairings/${encodeURIComponent(id)}/approve`, {
                method: 'POST',
                body: JSON.stringify({claimId: claim}),
            });
        },

        async listMobileSessions() {
            return (await accountValue(
                mobileSessionsSchema,
                '/api/me/mobile-sessions',
                {method: 'GET'},
            )).devices;
        },

        async revokeMobileSession(deviceId) {
            const id = parseInput(mobileSessionIdSchema, deviceId);
            await accountNoContent(
                `/api/me/mobile-sessions/${encodeURIComponent(id)}`,
                {method: 'DELETE'},
            );
        },

        async claimManualPairing(input) {
            const body = parseInput(manualPairingClaimInputSchema, input);
            return pairingValue(pairingClaimSchema, '/api/pairings/claims', {
                method: 'POST',
                body: JSON.stringify(body),
            });
        },

        async claimQrPairing(input) {
            const body = parseInput(qrPairingClaimInputSchema, input);
            return pairingValue(
                pairingClaimSchema,
                `/api/pairings/${encodeURIComponent(body.pairingId)}/claims`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        challenge: body.challenge,
                        installationId: body.installationId,
                        deviceLabel: body.deviceLabel,
                    }),
                },
            );
        },

        async prepareQrPairingHandoff(input) {
            const body = parseInput(qrPairingHandoffInputSchema, input);
            await responseNoContent(await pairingResponse(
                `/api/pairings/${encodeURIComponent(body.pairingId)}/handoff`,
                {
                    method: 'POST',
                    body: JSON.stringify({challenge: body.challenge}),
                },
            ));
        },

        async claimPairingHandoff(input) {
            const body = parseInput(pairingHandoffClaimInputSchema, input);
            const response = await pairingResponse('/api/pairings/handoffs/claims', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (response.status === 204) return null;
            return responseValue(pairingClaimSchema, response);
        },

        async completePairing(pairingId) {
            const id = parseInput(pairingIdSchema, pairingId);
            const response = await pairingResponse(
                `/api/pairings/${encodeURIComponent(id)}/complete`,
                {method: 'POST', body: JSON.stringify({})},
            );
            if (response.status === 409) {
                const parsed = pairingWaitingErrorSchema.safeParse(await safeResponseJson(response));
                if (parsed.success) return 'waiting';
            }
            await responseNoContent(response);
            return 'completed';
        },

        async getAccountSession() {
            const response = await accountResponse('/api/me/session', {method: 'GET'});
            if (response.status === 401) return null;
            return responseValue(browserAccountSessionSchema, response);
        },

        async disconnectMobileSession() {
            await accountNoContent('/api/me/session', {method: 'DELETE'});
        },

        async getNotifications() {
            return (await accountValue(
                dashboardNotificationsSchema,
                '/api/me/notifications?limit=20',
                {method: 'GET'},
            )).notifications;
        },

        async getDesktopNotificationInbox() {
            return parseNotificationInboxSnapshot(await nativeBridge.getNotificationInboxSnapshot());
        },

        async markDesktopNotificationRead(id) {
            const notificationId = parseInput(notificationInboxIdSchema, id);
            return parseNotificationInboxSnapshot(
                await nativeBridge.markNotificationRead(notificationId),
            );
        },

        async markAllDesktopNotificationsRead() {
            return parseNotificationInboxSnapshot(
                await nativeBridge.markAllNotificationsRead(),
            );
        },

        async activateDesktopNotification(id) {
            const notificationId = parseInput(notificationInboxIdSchema, id);
            return parseNotificationInboxSnapshot(
                await nativeBridge.activateNotification(notificationId),
            );
        },

        async sendDesktopTestNotification() {
            return parseDesktopTestNotificationResult(await nativeBridge.sendTestNotification());
        },

        async sendMobileTestNotification() {
            return (await accountValue(
                mobileTestNotificationResultSchema,
                '/api/me/notifications/test',
                {method: 'POST', body: JSON.stringify({})},
            )).queued;
        },

        async getPushPublicKey() {
            return (await accountValue(
                pushPublicKeyResultSchema,
                '/api/me/push/vapid-public-key',
                {method: 'GET'},
            )).publicKey;
        },

        async registerPushSubscription(subscription) {
            const body = parseInput(pushSubscriptionInputSchema, {
                endpoint: subscription.endpoint,
                keys: subscription.keys,
            });
            await accountValue(
                pushSubscriptionResultSchema,
                '/api/me/push/subscriptions',
                {
                    method: 'PUT',
                    body: JSON.stringify(body),
                },
            );
        },
    };
}

function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/u, '');
    if (!trimmed) return '';
    const parsed = new URL(trimmed);
    const localHttp = parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if ((parsed.protocol !== 'https:' && !localHttp)
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/') {
        throw new Error('DASHBOARD_API_URL_INVALID');
    }
    return parsed.origin;
}
