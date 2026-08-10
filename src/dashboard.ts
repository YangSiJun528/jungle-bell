import Alpine from 'alpinejs';
import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import packageMetadata from '../package.json';
import {
    createDashboardApi,
    parseDashboardLaundrySnapshot,
    parseDashboardMealsSnapshot,
    type AttendanceDashboard,
    type AttendanceSnapshot,
    type DashboardLaundryAppliance,
    type DashboardLaundrySnapshot,
    type DashboardMealPost,
    type DashboardMealsSnapshot,
    type DashboardNotification,
    type DesktopConnectionState,
    type DesktopDevice,
    type DashboardHomeOverview,
    type MobilePairingCreated,
    type MobilePairingStatus,
    type MobileSession,
    type PairingClaim,
} from './dashboard-api';
import {
    dashboardDdayLabel,
    dashboardDdayPeriod,
} from './dashboard-home';
import {buildDdayProgress, kstDateString} from './dday-progress';
import {
    attendanceHeadline,
    companionAuthenticationRequired,
    dashboardRouteForSurface,
    formatManualPairingCode,
    laundryCapacity,
    resolveDashboardSurface,
    validManualPairingCode,
    type DashboardLaundryMachine,
    type DashboardRoute,
    type DashboardSurface,
} from './dashboard-model';
import {
    dashboardNavigationRoutes,
    dashboardRouteTitle,
    dashboardSurfaceBadge,
    dashboardSurfaceFooter,
} from './dashboard-presentation';
import {pairingQrDataUrl} from './dashboard-qr';
import {detectDashboardRuntime} from './dashboard-runtime';
import {
    createMobileInstallationIdProvider,
    MOBILE_INSTALLATION_KEY,
} from './dashboard-installation';
import {createDashboardPersonalActions} from './dashboard-personal-controller';
import {initialDashboardPersonalState} from './dashboard-personal-state';
import type {DesktopSettings} from './dashboard-desktop-settings';
import {
    clearPendingMobilePairing,
    PENDING_MOBILE_PAIRING_TTL_MS,
    readPendingMobilePairing,
    storePendingMobilePairing,
    type PendingMobilePairing,
} from './dashboard-pending-pairing';
import {laundrySituationDataIsReliable} from './laundry-situation';
import {
    laundryAvailabilityState,
    laundryOverviewText,
    laundryRemainingText,
} from './laundry-status';
import {sortMealPostsByPeriod} from './meal-display';
import {
    EMPTY_NOTIFICATION_INBOX,
    normalizeNotificationInboxSnapshot,
    notificationTimeLabel,
    type NotificationInboxItem,
    type NotificationInboxSnapshot,
} from './notification-inbox';

type ResourceState = 'loading' | 'loaded' | 'error';
type AttendanceViewState = 'loading' | 'auth-required' | 'unavailable' | 'loaded' | 'error';
type NotificationViewState = 'loading' | 'auth-required' | 'loaded' | 'error';
type MobilePairingViewState = 'manual' | 'claiming' | 'waiting' | 'completed' | 'expired' | 'error';

interface CampusUpdate {
    kind: 'laundry' | 'meals';
    snapshot: {savedAt: number; data: unknown};
}

interface CampusError {
    kind: 'laundry' | 'meals';
    message: string;
}

interface PairingLink {
    pairingId: string;
    challenge: string;
}

interface DeferredInstallPrompt extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

const api = createDashboardApi();
const personalActions = createDashboardPersonalActions(api);
const PERSONAL_REFRESH_MS = 60_000;
const LAUNDRY_REFRESH_MS = 30_000;
const MEALS_REFRESH_MS = 5 * 60_000;
const SEEN_MOBILE_NOTIFICATIONS_KEY = 'jungle-bell:seen-mobile-notifications';
const INSTALL_NUDGE_DISMISSED_KEY = 'jungle-bell:install-nudge-dismissed';

function readSeenMobileNotificationIds(): string[] {
    try {
        const value = JSON.parse(window.localStorage.getItem(SEEN_MOBILE_NOTIFICATIONS_KEY) ?? '[]');
        if (!Array.isArray(value)) return [];
        return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 128))].slice(0, 100);
    } catch {
        return [];
    }
}

function pairingLinkFromLocation(): PairingLink | null {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const pairingId = fragment.get('pairing');
    const challenge = fragment.get('challenge');
    return pairingId && challenge ? {pairingId, challenge} : null;
}

function machineNumberValue(id: string): number | null {
    const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim());
    return match?.[1] ? Number(match[1]) : null;
}

function machineZone(id: string): DashboardLaundryMachine['zone'] {
    const number = machineNumberValue(id);
    if (number !== null && number >= 1 && number <= 5) return 'men';
    if (number !== null && number <= 7) return 'common';
    if (number !== null && number <= 9) return 'women';
    return 'other';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function normalizeLaundrySnapshot(value: unknown): DashboardLaundrySnapshot | null {
    try {
        return parseDashboardLaundrySnapshot(value);
    } catch {
        return null;
    }
}

function normalizeMealsSnapshot(value: unknown): DashboardMealsSnapshot | null {
    try {
        return parseDashboardMealsSnapshot(value);
    } catch {
        return null;
    }
}

const mobileInstallationId = createMobileInstallationIdProvider({
    read: () => window.localStorage.getItem(MOBILE_INSTALLATION_KEY),
    write: (value) => window.localStorage.setItem(MOBILE_INSTALLATION_KEY, value),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
});

function mobileDeviceLabel(): string {
    const platform = navigator.platform.trim();
    return platform ? `Jungle Bell · ${platform}`.slice(0, 80) : 'Jungle Bell 모바일';
}

function urlBase64ToBytes(value: string): ArrayBuffer {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const binary = atob((value + padding).replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function dashboard(): Record<string, any> {
    const runtime = detectDashboardRuntime();
    const tauri = runtime.runningInTauri;
    const pairingLink = pairingLinkFromLocation();
    const initialSurface = resolveDashboardSurface({
        runningInTauri: tauri,
        standalone: runtime.standalone,
    });

    return {
        ...initialDashboardPersonalState(),
        ...personalActions,
        activeRoute: pairingLink && initialSurface.kind !== 'public'
            ? 'connections'
            : dashboardRouteForSurface(window.location.hash, initialSurface.kind) as DashboardRoute,
        surface: initialSurface as DashboardSurface,
        initializing: true,
        attendanceState: 'loading' as AttendanceViewState,
        attendanceBusy: false,
        attendanceSnapshot: null as AttendanceSnapshot | null,
        attendanceLastSyncedAt: null as string | null,
        attendanceFreshness: 'missing' as 'fresh' | 'stale' | 'missing',
        attendanceDevices: [] as DesktopDevice[],
        desktopConnection: null as DesktopConnectionState | null,
        dashboardHomeOverview: null as DashboardHomeOverview | null,
        dashboardHomeOverviewState: 'loading' as ResourceState,
        appVersion: packageMetadata.version,
        desktopSettings: null as DesktopSettings | null,
        desktopSettingsState: 'loading' as ResourceState,
        desktopSettingsBusy: false,
        desktopSettingsMessage: '',
        syncBusy: false,
        identityResetBusy: false,
        laundryState: 'loading' as ResourceState,
        laundryMachines: [] as DashboardLaundryMachine[],
        laundryCapacityView: {men: null, women: null} as {men: number | null; women: number | null},
        laundryUpdatedAt: null as string | null,
        laundryError: null as string | null,
        mealsState: 'loading' as ResourceState,
        mealsSnapshot: null as DashboardMealsSnapshot | null,
        mealsUpdatedAt: null as string | null,
        notificationState: 'loading' as NotificationViewState,
        notifications: [] as DashboardNotification[],
        desktopNotificationInbox: {...EMPTY_NOTIFICATION_INBOX} as NotificationInboxSnapshot,
        seenMobileNotificationIds: readSeenMobileNotificationIds(),
        pushPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
        pushBusy: false,
        notificationTestBusy: false,
        desktopPairing: null as MobilePairingCreated | null,
        desktopPairingStatus: null as MobilePairingStatus | null,
        pairingQrUrl: '',
        pairingRemainingSeconds: 0,
        pairingBusy: false,
        pairingMessage: '',
        mobileSessions: [] as MobileSession[],
        sessionsState: 'loading' as ResourceState,
        sessionBusyId: null as string | null,
        manualPairingCode: '',
        mobilePairingState: 'manual' as MobilePairingViewState,
        mobilePairingMessage: '',
        mobileConfirmationCode: '',
        pendingMobilePairing: null as PendingMobilePairing | null,
        toastMessage: '',
        toastTimer: null as number | null,
        installPrompt: null as DeferredInstallPrompt | null,
        installPromptAvailable: false,
        installNudgeOpen: false,
        unlisteners: [] as UnlistenFn[],
        personalRefreshTimer: null as number | null,
        laundryRefreshTimer: null as number | null,
        mealsRefreshTimer: null as number | null,
        desktopPairingTimer: null as number | null,
        mobilePairingTimer: null as number | null,
        pairingStatusInFlight: false,
        hashHandler: null as (() => void) | null,
        installPromptHandler: null as ((event: Event) => void) | null,

        get homeDdayProgress() {
            const period = this.dashboardHomeOverview?.attendance.ddayPeriod
                ?? (this.attendanceSnapshot ? dashboardDdayPeriod(this.attendanceSnapshot) : null);
            return period ? buildDdayProgress(period, kstDateString()) : null;
        },

        async init(this: any) {
            this.hashHandler = () => {
                if (pairingLinkFromLocation() && this.surface.kind === 'companion') return;
                this.activeRoute = dashboardRouteForSurface(window.location.hash, this.surface.kind);
                if (window.location.hash !== `#${this.activeRoute}`) {
                    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${this.activeRoute}`);
                }
                document.title = `${this.routeTitle(this.activeRoute)} · Jungle Bell`;
                this.resetScrollPosition();
            };
            window.addEventListener('hashchange', this.hashHandler);
            if (!pairingLink && window.location.hash !== `#${this.activeRoute}`) {
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${this.activeRoute}`);
            }
            this.installPromptHandler = (event: Event) => {
                event.preventDefault();
                this.installPrompt = event as DeferredInstallPrompt;
                this.installPromptAvailable = true;
            };
            window.addEventListener('beforeinstallprompt', this.installPromptHandler);
            await this.registerServiceWorker();
            if (this.surface.kind === 'public') {
                try {
                    this.installNudgeOpen = window.sessionStorage.getItem(INSTALL_NUDGE_DISMISSED_KEY) !== 'true';
                } catch {
                    this.installNudgeOpen = true;
                }
            }
            if (tauri) {
                try {
                    this.unlisteners.push(await listen<NotificationInboxSnapshot>('notification-inbox-updated', (event) => {
                        const snapshot = normalizeNotificationInboxSnapshot(event.payload);
                        if (snapshot) this.desktopNotificationInbox = snapshot;
                    }));
                } catch (error) {
                    console.error('[dashboard] notification inbox listener failed', error);
                }
            }

            await Promise.allSettled([
                this.initializeCampusData(),
                this.initializePersonalData(),
            ]);
            this.startRefreshTimers();
            this.initializing = false;
            this.resetScrollPosition();

            if (pairingLink && this.surface.kind === 'companion') {
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#connections`);
                await this.claimQrLink(pairingLink);
            } else if (this.surface.kind === 'companion' && this.restorePendingMobilePairing()) {
                this.activeRoute = 'connections';
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#connections`);
            } else if (pairingLink) {
                this.activeRoute = 'home';
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#home`);
                this.showToast('PWA를 설치해 실행한 뒤 PC의 10자리 연결 코드를 입력해 주세요.');
            }
        },

        destroy(this: any) {
            if (this.hashHandler) window.removeEventListener('hashchange', this.hashHandler);
            if (this.installPromptHandler) window.removeEventListener('beforeinstallprompt', this.installPromptHandler);
            for (const timer of [
                this.personalRefreshTimer,
                this.laundryRefreshTimer,
                this.mealsRefreshTimer,
                this.desktopPairingTimer,
                this.mobilePairingTimer,
                this.toastTimer,
            ]) {
                if (timer !== null) window.clearTimeout(timer);
            }
            this.unlisteners.forEach((unlisten: UnlistenFn) => unlisten());
            this.unlisteners = [];
        },

        selectRoute(this: any, route: DashboardRoute) {
            const selected = dashboardRouteForSurface(`#${route}`, this.surface.kind);
            this.activeRoute = selected;
            if (window.location.hash !== `#${selected}`) window.location.hash = selected;
            document.title = `${this.routeTitle(selected)} · Jungle Bell`;
            if (selected === 'notifications') this.markMobileNotificationsSeen();
            this.resetScrollPosition();
        },

        navigationRouteVisible(this: any, route: DashboardRoute) {
            return dashboardNavigationRoutes(this.surface.kind).includes(route);
        },

        resetScrollPosition() {
            window.requestAnimationFrame(() => {
                document.documentElement.scrollTop = 0;
                document.body.scrollTop = 0;
            });
        },

        routeTitle(_this: any, route?: DashboardRoute) {
            const current = route ?? _this;
            return dashboardRouteTitle(current as DashboardRoute);
        },

        async initializeCampusData(this: any) {
            if (!tauri) {
                await Promise.allSettled([this.loadLaundry(false), this.loadMeals(false)]);
                return;
            }
            try {
                this.unlisteners.push(await listen<CampusUpdate>('campus-data-updated', (event) => {
                    this.applyCampusUpdate(event.payload);
                }));
                this.unlisteners.push(await listen<CampusError>('campus-data-error', (event) => {
                    if (event.payload.kind === 'laundry') {
                        this.laundryError = event.payload.message;
                        if (this.laundryMachines.length === 0) this.laundryState = 'error';
                    } else if (!this.mealsSnapshot) {
                        this.mealsState = 'error';
                    }
                }));
                await invoke('report_campus_ready');
                await Promise.allSettled([
                    this.loadLaundry(false),
                    this.loadMeals(false),
                ]);
            } catch (error) {
                console.error('[dashboard] campus IPC initialization failed', error);
                await Promise.allSettled([this.loadLaundry(false), this.loadMeals(false)]);
            }
        },

        applyCampusUpdate(this: any, update: CampusUpdate) {
            if (update.kind === 'laundry') {
                const snapshot = normalizeLaundrySnapshot(update.snapshot.data);
                if (snapshot) this.applyLaundry(snapshot, update.snapshot.savedAt);
            } else {
                const snapshot = normalizeMealsSnapshot(update.snapshot.data);
                if (snapshot) this.applyMeals(snapshot);
            }
        },

        async loadLaundry(this: any, manual = false) {
            if (tauri) {
                try {
                    await invoke('refresh_campus_data', {kind: 'laundry'});
                } catch (error) {
                    console.error('[dashboard] laundry IPC refresh failed', error);
                    if (manual) this.showToast('세탁실 정보를 갱신하지 못했어요.');
                    if (this.laundryMachines.length === 0) this.laundryState = 'error';
                }
                return;
            }
            if (this.laundryMachines.length === 0) this.laundryState = 'loading';
            try {
                const snapshot = await api.getPublicLaundry();
                this.applyLaundry(snapshot, Date.parse(snapshot.asOf));
            } catch (error) {
                console.error('[dashboard] laundry load failed', error);
                this.laundryError = String(error);
                if (this.laundryMachines.length === 0) this.laundryState = 'error';
            }
        },

        applyLaundry(this: any, snapshot: DashboardLaundrySnapshot, savedAt: number) {
            this.laundryMachines = [...snapshot.machines]
                .map((machine) => ({...machine, zone: machine.zone ?? machineZone(machine.id)}))
                .sort((left, right) => (machineNumberValue(left.id) ?? 999) - (machineNumberValue(right.id) ?? 999));
            this.laundryUpdatedAt = snapshot.quality.lastCheckedAt ?? snapshot.asOf;
            this.laundryError = null;
            const reliable = snapshot.quality.collection === 'SUCCESS'
                && laundrySituationDataIsReliable({
                    hasData: this.laundryMachines.length > 0,
                    error: null,
                    sourceFreshness: snapshot.quality.sourceFreshness,
                    snapshotSavedAt: Number.isFinite(savedAt) ? savedAt : Date.parse(snapshot.asOf),
                    nowMs: Date.now(),
                });
            this.laundryCapacityView = laundryCapacity(snapshot.capacity, reliable);
            this.laundryState = 'loaded';
            this.ensureLaundryTargetSelection();
        },

        async loadMeals(this: any, manual = false) {
            if (tauri) {
                try {
                    await invoke('refresh_campus_data', {kind: 'meals'});
                } catch (error) {
                    console.error('[dashboard] meals IPC refresh failed', error);
                    if (manual) this.showToast('식단을 갱신하지 못했어요.');
                    if (!this.mealsSnapshot) this.mealsState = 'error';
                }
                return;
            }
            if (!this.mealsSnapshot) this.mealsState = 'loading';
            try {
                this.applyMeals(await api.getPublicMeals());
            } catch (error) {
                console.error('[dashboard] meals load failed', error);
                if (!this.mealsSnapshot) this.mealsState = 'error';
            }
        },

        applyMeals(this: any, snapshot: DashboardMealsSnapshot) {
            this.mealsSnapshot = snapshot;
            this.mealsUpdatedAt = snapshot.lastCheckedAt ?? snapshot.asOf;
            this.mealsState = 'loaded';
        },

        async initializePersonalData(this: any) {
            if (this.surface.kind === 'desktop') {
                await Promise.allSettled([
                    this.loadDashboardHomeOverview(),
                    this.loadDesktopConnection(),
                    this.loadDesktopSettings(),
                    this.refreshAttendance(),
                    this.loadSessions(),
                    this.loadDesktopNotificationInbox(),
                    this.loadPersonalControls(),
                ]);
                return;
            }
            if (this.surface.kind === 'companion') {
                await Promise.allSettled([
                    this.refreshAttendance(),
                    this.loadNotifications(),
                    this.loadPersonalControls(),
                ]);
                return;
            }
            this.attendanceState = 'auth-required';
            this.notificationState = 'auth-required';
            this.sessionsState = 'loaded';
        },

        async loadDashboardHomeOverview(this: any) {
            if (this.surface.kind !== 'desktop') return;
            if (!this.dashboardHomeOverview) this.dashboardHomeOverviewState = 'loading';
            try {
                this.dashboardHomeOverview = await api.getDashboardHomeOverview();
                this.appVersion = this.dashboardHomeOverview.attendance.currentVersion;
                this.dashboardHomeOverviewState = 'loaded';
            } catch (error) {
                console.error('[dashboard] home overview load failed', error);
                if (!this.dashboardHomeOverview) this.dashboardHomeOverviewState = 'error';
            }
        },

        async loadDesktopConnection(this: any) {
            try {
                this.desktopConnection = await api.getDesktopConnectionState();
            } catch (error) {
                console.error('[dashboard] desktop connection load failed', error);
                this.desktopConnection = {
                    state: 'unknown', desktopId: null, lastVerifiedAt: null, lastSeenAt: null,
                    health: null, lmsSessionState: 'unknown',
                };
            }
        },

        async loadDesktopSettings(this: any) {
            if (this.surface.kind !== 'desktop') return;
            if (!this.desktopSettings) this.desktopSettingsState = 'loading';
            try {
                this.desktopSettings = await api.getDesktopSettings();
                this.desktopSettingsState = 'loaded';
            } catch (error) {
                console.error('[dashboard] desktop settings load failed', error);
                if (!this.desktopSettings) this.desktopSettingsState = 'error';
            }
        },

        async updateAutoStart(this: any, checked: boolean) {
            if (this.surface.kind !== 'desktop' || typeof checked !== 'boolean' || this.desktopSettingsBusy) return;
            this.desktopSettingsBusy = true;
            this.desktopSettingsMessage = '';
            try {
                this.desktopSettings = await api.updateDesktopSettings({autoStart: checked});
                this.desktopSettingsState = 'loaded';
                this.desktopSettingsMessage = checked
                    ? 'PC 로그인 시 Jungle Bell을 자동으로 실행합니다.'
                    : '자동 실행을 끄었습니다.';
            } catch (error) {
                console.error('[dashboard] desktop settings update failed', error);
                this.desktopSettingsMessage = '자동 실행 설정을 변경하지 못했어요.';
            } finally {
                this.desktopSettingsBusy = false;
            }
        },

        async resetDesktopIdentity(this: any) {
            if (this.identityResetBusy || !window.confirm(
                '이 PC의 Jungle Bell 연결 정보를 새로 만들까요? 기존 모바일 연결은 다시 연결해야 합니다.',
            )) return;
            this.identityResetBusy = true;
            try {
                this.desktopConnection = await api.resetDesktopIdentity();
                this.desktopPairing = null;
                this.desktopPairingStatus = null;
                await Promise.allSettled([
                    this.refreshAttendance(),
                    this.loadSessions(),
                    this.loadPersonalControls(),
                ]);
                this.showToast('새 PC 연결 정보를 만들었어요. 모바일을 다시 연결해 주세요.');
            } catch (error) {
                console.error('[dashboard] desktop identity reset failed', error);
                this.showToast('PC 연결 정보를 초기화하지 못했어요.');
            } finally {
                this.identityResetBusy = false;
            }
        },

        async refreshAttendance(this: any) {
            if (this.surface.kind === 'public' || this.attendanceBusy) return;
            this.attendanceBusy = true;
            if (!this.attendanceSnapshot) this.attendanceState = 'loading';
            try {
                const result = await api.getAttendance(this.surface.kind);
                this.applyAttendance(result);
            } catch (error) {
                console.error('[dashboard] attendance load failed', error);
                if (!this.attendanceSnapshot) this.attendanceState = 'error';
            } finally {
                this.attendanceBusy = false;
            }
        },

        applyAttendance(this: any, result: AttendanceDashboard) {
            if (result.state === 'auth-required') {
                this.attendanceState = 'auth-required';
                this.attendanceSnapshot = null;
                return;
            }
            this.attendanceDevices = result.devices;
            if (result.attendance.status === 'unavailable') {
                this.attendanceState = 'unavailable';
                this.attendanceSnapshot = null;
                this.attendanceLastSyncedAt = null;
                this.attendanceFreshness = 'missing';
                return;
            }
            this.attendanceSnapshot = result.attendance.snapshot;
            this.attendanceLastSyncedAt = result.attendance.lastSyncedAt;
            this.attendanceFreshness = result.attendance.freshness;
            this.attendanceState = 'loaded';
        },

        attendanceView(this: any) {
            return this.attendanceSnapshot
                ? attendanceHeadline(this.attendanceSnapshot)
                : {label: '출석 확인 대기 중', tone: 'warning'};
        },

        async syncNow(this: any) {
            if (this.syncBusy) return;
            this.syncBusy = true;
            try {
                await api.refreshPlatformSync();
                await Promise.allSettled([
                    this.loadDashboardHomeOverview(),
                    this.loadDesktopConnection(),
                    this.refreshAttendance(),
                ]);
                this.showToast('최신 상태를 확인했어요.');
            } catch (error) {
                console.error('[dashboard] platform sync failed', error);
                this.showToast('동기화하지 못했어요. 네트워크를 확인해 주세요.');
            } finally {
                this.syncBusy = false;
            }
        },

        async openLmsLogin(this: any) {
            try {
                await api.openLmsLogin();
            } catch (error) {
                console.error('[dashboard] LMS login window failed', error);
                this.showToast('LMS 로그인 창을 열지 못했어요.');
            }
        },

        async loadNotifications(this: any) {
            if (this.surface.kind === 'desktop') {
                await this.loadDesktopNotificationInbox();
                return;
            }
            if (this.surface.kind !== 'companion') {
                this.notificationState = 'auth-required';
                return;
            }
            this.notificationState = 'loading';
            try {
                this.notifications = await api.getNotifications();
                this.notificationState = 'loaded';
                if (this.activeRoute === 'notifications') this.markMobileNotificationsSeen();
            } catch (error) {
                if (companionAuthenticationRequired(error)) {
                    this.notifications = [];
                    this.notificationState = 'auth-required';
                } else {
                    console.error('[dashboard] notifications load failed', error);
                    this.notificationState = 'error';
                }
            }
        },

        async loadDesktopNotificationInbox(this: any) {
            if (this.surface.kind !== 'desktop') return;
            this.notificationState = 'loading';
            try {
                this.desktopNotificationInbox = await api.getDesktopNotificationInbox();
                this.notificationState = 'loaded';
            } catch (error) {
                console.error('[dashboard] desktop notification inbox failed', error);
                this.notificationState = 'error';
            }
        },

        markMobileNotificationsSeen(this: any) {
            if (this.surface.kind !== 'companion' || this.notifications.length === 0) return;
            const ids = this.notifications.map((notification: DashboardNotification) => notification.id);
            this.seenMobileNotificationIds = [...new Set([...ids, ...this.seenMobileNotificationIds])].slice(0, 100);
            try {
                window.localStorage.setItem(
                    SEEN_MOBILE_NOTIFICATIONS_KEY,
                    JSON.stringify(this.seenMobileNotificationIds),
                );
            } catch {
                // The current page still reflects the seen state when storage is unavailable.
            }
        },

        async openDesktopNotification(this: any, item: NotificationInboxItem) {
            try {
                this.desktopNotificationInbox = await api.activateDesktopNotification(item.id);
            } catch (error) {
                console.error('[dashboard] desktop notification activation failed', error);
                this.showToast('알림을 열지 못했어요.');
            }
        },

        async enablePush(this: any) {
            if (this.surface.kind !== 'companion') {
                this.selectRoute('connections');
                this.showToast('PC와 연결한 뒤 모바일 푸시를 설정해 주세요.');
                return;
            }
            if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
                this.pushPermission = 'unsupported';
                return;
            }
            this.pushBusy = true;
            try {
                const permission = await Notification.requestPermission();
                this.pushPermission = permission;
                if (permission !== 'granted') return;
                const registration = await navigator.serviceWorker.ready;
                const publicKey = await api.getPushPublicKey();
                const existing = await registration.pushManager.getSubscription();
                const subscription = existing ?? await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToBytes(publicKey),
                });
                await api.registerPushSubscription(subscription.toJSON());
                this.showToast('이 기기에서 모바일 푸시를 받을 수 있어요.');
            } catch (error) {
                console.error('[dashboard] push setup failed', error);
                this.showToast('모바일 푸시를 연결하지 못했어요.');
            } finally {
                this.pushBusy = false;
            }
        },

        async sendTestNotification(this: any) {
            if (this.notificationTestBusy) return;
            this.notificationTestBusy = true;
            try {
                if (this.surface.kind === 'desktop') {
                    const result = await api.sendDesktopTestNotification();
                    this.desktopNotificationInbox = result.snapshot;
                    this.notificationState = 'loaded';
                    if (result.systemDelivered && result.mobileQueued !== null) {
                        this.showToast(result.mobileQueued > 0
                            ? `PC와 연결된 모바일 ${result.mobileQueued}대에 테스트 알림을 보냈어요.`
                            : 'PC 테스트 알림을 보냈어요. 연결된 모바일 푸시는 없어요.');
                    } else if (result.systemDelivered) {
                        this.showToast('PC 알림은 보냈지만 모바일 테스트 전송은 실패했어요.');
                    } else if (result.mobileQueued !== null && result.mobileQueued > 0) {
                        this.showToast(`모바일 ${result.mobileQueued}대에는 보냈지만 PC 운영체제 알림은 실패했어요.`);
                    } else {
                        this.showToast('알림함에는 추가했지만 운영체제 알림을 표시하지 못했어요. 알림 권한을 확인해 주세요.');
                    }
                    return;
                }
                if (this.surface.kind !== 'companion') return;
                await this.enablePush();
                if (this.pushPermission !== 'granted') {
                    this.showToast('알림 권한을 허용한 뒤 다시 테스트해 주세요.');
                    return;
                }
                const queued = await api.sendMobileTestNotification();
                await this.loadNotifications();
                this.showToast(`연결된 모바일 ${queued}대에 테스트 푸시를 보냈어요. PC 앱에도 잠시 후 표시됩니다.`);
            } catch (error) {
                console.error('[dashboard] test notification failed', error);
                const message = error instanceof Error ? error.message : '';
                if (/TEST_NOTIFICATION_RATE_LIMITED/u.test(message)) {
                    this.showToast('테스트 알림은 30초에 한 번 보낼 수 있어요.');
                } else if (/PUSH_SUBSCRIPTION_REQUIRED/u.test(message)) {
                    this.showToast('모바일 푸시를 다시 연결한 뒤 테스트해 주세요.');
                } else {
                    this.showToast('테스트 알림을 보내지 못했어요.');
                }
            } finally {
                this.notificationTestBusy = false;
            }
        },

        async startDesktopPairing(this: any) {
            if (this.pairingBusy) return;
            this.pairingBusy = true;
            this.pairingMessage = '';
            try {
                const pairing = await api.createMobilePairing();
                this.desktopPairing = pairing;
                this.desktopPairingStatus = {status: 'pending', claim: null};
                this.pairingQrUrl = pairingQrDataUrl(pairing.qrPayload);
                this.updatePairingCountdown();
                this.startDesktopPairingPoll();
            } catch (error) {
                console.error('[dashboard] pairing create failed', error);
                this.pairingMessage = '연결 코드를 만들지 못했어요.';
            } finally {
                this.pairingBusy = false;
            }
        },

        startDesktopPairingPoll(this: any) {
            if (this.desktopPairingTimer !== null) window.clearInterval(this.desktopPairingTimer);
            this.desktopPairingTimer = window.setInterval(() => {
                this.updatePairingCountdown();
                void this.pollDesktopPairingStatus();
            }, 1_000);
            void this.pollDesktopPairingStatus();
        },

        updatePairingCountdown(this: any) {
            if (!this.desktopPairing) {
                this.pairingRemainingSeconds = 0;
                return;
            }
            this.pairingRemainingSeconds = Math.max(
                0,
                Math.ceil((Date.parse(this.desktopPairing.expiresAt) - Date.now()) / 1_000),
            );
            if (this.pairingRemainingSeconds === 0) {
                this.desktopPairingStatus = {status: 'expired', claim: null};
                this.pairingMessage = '연결 코드가 만료됐어요. 새 코드를 만들어 주세요.';
                if (this.desktopPairingTimer !== null) window.clearInterval(this.desktopPairingTimer);
                this.desktopPairingTimer = null;
            }
        },

        async pollDesktopPairingStatus(this: any) {
            if (!this.desktopPairing || this.pairingStatusInFlight || this.pairingRemainingSeconds === 0) return;
            if (this.desktopPairingStatus?.status === 'completed'
                || this.desktopPairingStatus?.status === 'expired') return;
            this.pairingStatusInFlight = true;
            try {
                const status = await api.getMobilePairingStatus(this.desktopPairing.pairingId);
                this.desktopPairingStatus = status;
                if (status.status === 'completed') {
                    this.pairingMessage = '휴대폰 연결이 완료됐어요.';
                    if (this.desktopPairingTimer !== null) window.clearInterval(this.desktopPairingTimer);
                    this.desktopPairingTimer = null;
                    await this.loadSessions();
                } else if (status.status === 'expired') {
                    this.pairingRemainingSeconds = 0;
                    this.pairingMessage = '연결 코드가 만료됐어요. 새 코드를 만들어 주세요.';
                    if (this.desktopPairingTimer !== null) window.clearInterval(this.desktopPairingTimer);
                    this.desktopPairingTimer = null;
                }
            } catch (error) {
                console.error('[dashboard] pairing status failed', error);
            } finally {
                this.pairingStatusInFlight = false;
            }
        },

        async approveDesktopClaim(this: any) {
            const claim = this.desktopPairingStatus?.claim;
            if (!this.desktopPairing || !claim || this.pairingBusy) return;
            this.pairingBusy = true;
            try {
                await api.approveMobilePairing(this.desktopPairing.pairingId, claim.claimId);
                this.desktopPairingStatus = {status: 'approved', claim: null};
                this.pairingMessage = '승인했어요. 휴대폰 연결 완료를 기다리고 있어요.';
                await this.loadSessions();
            } catch (error) {
                console.error('[dashboard] pairing approve failed', error);
                this.pairingMessage = '이 휴대폰을 승인하지 못했어요.';
            } finally {
                this.pairingBusy = false;
            }
        },

        async loadSessions(this: any) {
            if (this.surface.kind !== 'desktop') return;
            this.sessionsState = 'loading';
            try {
                this.mobileSessions = (await api.listMobileSessions()).filter((session) => session.status === 'active');
                this.sessionsState = 'loaded';
            } catch (error) {
                console.error('[dashboard] mobile sessions load failed', error);
                this.sessionsState = 'error';
            }
        },

        async revokeSession(this: any, deviceId: string) {
            if (this.sessionBusyId) return;
            this.sessionBusyId = deviceId;
            try {
                await api.revokeMobileSession(deviceId);
                this.mobileSessions = this.mobileSessions.filter((session: MobileSession) => session.deviceId !== deviceId);
                this.showToast('모바일 연결을 해제했어요.');
            } catch (error) {
                console.error('[dashboard] session revoke failed', error);
                this.showToast('연결을 해제하지 못했어요.');
            } finally {
                this.sessionBusyId = null;
            }
        },

        updateManualCode(this: any, value: string) {
            this.manualPairingCode = formatManualPairingCode(value);
        },

        async claimManualCode(this: any) {
            if (!validManualPairingCode(this.manualPairingCode)) {
                this.mobilePairingState = 'error';
                this.mobilePairingMessage = '10자리 연결 코드를 확인해 주세요.';
                return;
            }
            await this.claimMobilePairing(() => api.claimManualPairing({
                manualCode: this.manualPairingCode,
                deviceLabel: mobileDeviceLabel(),
                installationId: mobileInstallationId(),
            }));
        },

        async claimQrLink(this: any, link: PairingLink) {
            await this.claimMobilePairing(() => api.claimQrPairing({
                pairingId: link.pairingId,
                challenge: link.challenge,
                deviceLabel: mobileDeviceLabel(),
                installationId: mobileInstallationId(),
            }), link.pairingId);
        },

        async claimMobilePairing(
            this: any,
            claimRequest: () => Promise<PairingClaim>,
            requestedPairingId?: string,
        ) {
            if (this.pairingBusy) return;
            if (this.mobilePairingTimer !== null) window.clearTimeout(this.mobilePairingTimer);
            this.mobilePairingTimer = null;
            this.clearPendingMobilePairing();
            this.pairingBusy = true;
            this.mobilePairingState = 'claiming';
            this.mobilePairingMessage = '';
            try {
                const installationId = mobileInstallationId();
                const claim = await claimRequest();
                this.mobileConfirmationCode = installationId.slice(-4).toUpperCase();
                this.pendingMobilePairing = {
                    pairingId: requestedPairingId ?? claim.claimId,
                    claimId: claim.claimId,
                    createdAtEpochMs: Date.now(),
                };
                try {
                    storePendingMobilePairing(window.sessionStorage, this.pendingMobilePairing);
                } catch (error) {
                    console.warn('[dashboard] pending pairing session storage unavailable', error);
                }
                this.mobilePairingState = 'waiting';
                this.scheduleMobileCompletion(0);
            } catch (error) {
                console.error('[dashboard] mobile pairing claim failed', error);
                this.mobilePairingState = error instanceof Error && /EXPIRED/u.test(error.message)
                    ? 'expired'
                    : 'error';
                this.mobilePairingMessage = this.mobilePairingState === 'expired'
                    ? '연결 코드가 만료됐어요. PC에서 새 코드를 만들어 주세요.'
                    : '연결을 요청하지 못했어요. 코드와 네트워크를 확인해 주세요.';
            } finally {
                this.pairingBusy = false;
            }
        },

        scheduleMobileCompletion(this: any, delay: number) {
            if (this.mobilePairingTimer !== null) window.clearTimeout(this.mobilePairingTimer);
            this.mobilePairingTimer = window.setTimeout(() => void this.pollMobileCompletion(), delay);
        },

        restorePendingMobilePairing(this: any): boolean {
            let pending: PendingMobilePairing | null = null;
            try {
                pending = readPendingMobilePairing(window.sessionStorage, Date.now());
            } catch (error) {
                console.warn('[dashboard] pending pairing session storage unavailable', error);
            }
            if (!pending) return false;
            if (this.attendanceState !== 'auth-required') {
                this.clearPendingMobilePairing();
                return false;
            }
            this.pendingMobilePairing = pending;
            this.mobileConfirmationCode = mobileInstallationId().slice(-4).toUpperCase();
            this.mobilePairingState = 'waiting';
            this.mobilePairingMessage = '';
            this.scheduleMobileCompletion(0);
            return true;
        },

        clearPendingMobilePairing(this: any) {
            this.pendingMobilePairing = null;
            try {
                clearPendingMobilePairing(window.sessionStorage);
            } catch (error) {
                console.warn('[dashboard] pending pairing session storage unavailable', error);
            }
        },

        async pollMobileCompletion(this: any) {
            const pending = this.pendingMobilePairing;
            if (!pending || this.mobilePairingState !== 'waiting') return;
            if (Date.now() - pending.createdAtEpochMs >= PENDING_MOBILE_PAIRING_TTL_MS) {
                this.clearPendingMobilePairing();
                this.mobilePairingState = 'expired';
                this.mobilePairingMessage = '연결 요청이 만료됐어요. PC에서 새 코드를 만들어 주세요.';
                return;
            }
            try {
                const result = await api.completePairing(pending.pairingId);
                if (result === 'waiting') {
                    this.scheduleMobileCompletion(1_000);
                    return;
                }
                this.clearPendingMobilePairing();
                this.mobilePairingState = 'completed';
                await Promise.allSettled([
                    this.refreshAttendance(),
                    this.loadNotifications(),
                    this.loadPersonalControls(),
                ]);
            } catch (error) {
                console.error('[dashboard] mobile pairing completion failed', error);
                if (error instanceof Error && /EXPIRED|NOT_FOUND|CLAIM|ALREADY_USED/u.test(error.message)) {
                    this.clearPendingMobilePairing();
                    this.mobilePairingState = /EXPIRED/u.test(error.message) ? 'expired' : 'error';
                    this.mobilePairingMessage = '연결 요청을 완료할 수 없어요. PC에서 새 코드를 만들어 주세요.';
                    return;
                }
                this.scheduleMobileCompletion(3_000);
            }
        },

        async disconnectThisMobile(this: any) {
            if (!window.confirm('이 기기의 Jungle Bell 연결을 해제할까요?')) return;
            try {
                await api.disconnectMobileSession();
                this.attendanceState = 'auth-required';
                this.notificationState = 'auth-required';
                this.personalControlsState = 'auth-required';
                this.attendancePreferences = null;
                this.mealPreferences = null;
                this.laundryWatches = [];
                this.laundryQueue = [];
                this.notifications = [];
                this.selectRoute('connections');
                this.showToast('이 기기의 연결을 해제했어요.');
            } catch (error) {
                console.error('[dashboard] mobile disconnect failed', error);
                this.showToast('연결을 해제하지 못했어요.');
            }
        },

        startRefreshTimers(this: any) {
            this.personalRefreshTimer = window.setInterval(() => {
                if (this.surface.kind === 'desktop') {
                    void this.loadDashboardHomeOverview();
                    void this.loadDesktopConnection();
                }
                void this.refreshAttendance();
                void this.loadNotifications();
                void this.refreshLaundryPersonalControls(false);
            }, PERSONAL_REFRESH_MS);
            this.laundryRefreshTimer = window.setInterval(() => void this.loadLaundry(false), LAUNDRY_REFRESH_MS);
            this.mealsRefreshTimer = window.setInterval(() => void this.loadMeals(false), MEALS_REFRESH_MS);
        },

        async recoverOnline(this: any) {
            await Promise.allSettled([
                ...(this.surface.kind === 'desktop'
                    ? [this.loadDashboardHomeOverview(), this.loadDesktopConnection()]
                    : []),
                this.loadLaundry(false),
                this.loadMeals(false),
                this.refreshAttendance(),
                this.loadNotifications(),
                this.loadPersonalControls(true),
            ]);
        },

        async registerServiceWorker() {
            if (tauri || !('serviceWorker' in navigator)) return;
            try {
                await navigator.serviceWorker.register('./sw.js', {scope: './'});
            } catch (error) {
                console.error('[dashboard] service worker registration failed', error);
            }
        },

        async installPwa(this: any) {
            if (!this.installPrompt) return;
            await this.installPrompt.prompt();
            const choice = await this.installPrompt.userChoice;
            this.installPrompt = null;
            this.installPromptAvailable = false;
            if (choice.outcome === 'accepted') this.dismissInstallNudge();
        },

        openInstallNudge(this: any) {
            this.installNudgeOpen = true;
        },

        dismissInstallNudge(this: any) {
            this.installNudgeOpen = false;
            try {
                window.sessionStorage.setItem(INSTALL_NUDGE_DISMISSED_KEY, 'true');
            } catch {
                // A dismissed dialog stays closed for the current page without storage.
            }
        },

        showToast(this: any, message: string) {
            this.toastMessage = message;
            if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
            this.toastTimer = window.setTimeout(() => {
                this.toastMessage = '';
                this.toastTimer = null;
            }, 4_000);
        },

        todayLabel() {
            return new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
            }).format(new Date());
        },

        homeAttendanceLabel(this: any) {
            if (this.surface.kind === 'public') return '앱에서 확인';
            if (this.surface.kind === 'desktop' && this.dashboardHomeOverview) {
                return this.dashboardHomeOverview.attendance.statusText;
            }
            if (this.attendanceState === 'loading') return '확인 중';
            if (this.attendanceState === 'auth-required') return 'PC 연결 필요';
            if (this.attendanceState === 'unavailable') return '동기화 대기';
            if (this.attendanceState === 'error') return '불러오기 실패';
            return this.attendanceView().label;
        },

        homeAttendanceTone(this: any) {
            if (this.surface.kind === 'public' || this.attendanceState === 'loading') return 'neutral';
            const localStatus = this.surface.kind === 'desktop'
                ? this.dashboardHomeOverview?.attendance.status
                : null;
            if (localStatus === 'complete') return 'success';
            if (localStatus === 'active') return 'danger';
            if (localStatus === 'needsLogin') return 'warning';
            if (localStatus) return 'neutral';
            if (this.attendanceState === 'error') return 'danger';
            if (this.attendanceState !== 'loaded') return 'warning';
            return this.attendanceView().tone;
        },

        homeLmsLabel(this: any) {
            const state = this.surface.kind === 'desktop'
                ? this.dashboardHomeOverview?.lmsSessionState ?? this.desktopConnection?.lmsSessionState
                : (this.attendanceDevices[0] as DesktopDevice | undefined)?.lmsSessionState;
            if (state === 'connected') return '정글캠퍼스 연결됨';
            if (state === 'login-required') return '로그인이 필요해요';
            return '연결 상태 확인 중';
        },

        homeLmsTone(this: any) {
            const state = this.surface.kind === 'desktop'
                ? this.dashboardHomeOverview?.lmsSessionState ?? this.desktopConnection?.lmsSessionState
                : (this.attendanceDevices[0] as DesktopDevice | undefined)?.lmsSessionState;
            if (state === 'connected') return 'success';
            if (state === 'login-required') return 'warning';
            return 'neutral';
        },

        homeDdayLabel(this: any) {
            const local = this.dashboardHomeOverview?.attendance.ddayText;
            if (this.surface.kind === 'desktop' && local) return local;
            return this.attendanceSnapshot
                ? dashboardDdayLabel(this.attendanceSnapshot, kstDateString()) ?? '과정 일정 확인 중'
                : '과정 일정 확인 중';
        },

        homeDdayVisible(this: any) {
            return Boolean(this.dashboardHomeOverview?.attendance.ddayText || this.homeDdayProgress);
        },

        homeDdayRange(this: any) {
            const period = this.dashboardHomeOverview?.attendance.ddayPeriod
                ?? (this.attendanceSnapshot ? dashboardDdayPeriod(this.attendanceSnapshot) : null);
            if (!period) return '';
            const compact = (value: string) => value.split('-').map(Number).join('.');
            return `${compact(period.startDate)} – ${compact(period.endDate)}`;
        },

        homeDdayProgressLabel(this: any) {
            const progress = this.homeDdayProgress;
            if (!progress) return '';
            const current = progress.current ? ', 오늘 진행 중' : '';
            return `코스 진행률 ${progress.percent}%, 완료 ${progress.elapsed}일${current}, 남음 ${progress.remaining}일`;
        },

        homeLaundryLabel(this: any) {
            if (this.laundryState === 'loading') return '확인 중';
            if (this.laundryState === 'error') return '불러오기 실패';
            const men = this.capacityText(this.laundryCapacityView.men);
            const women = this.capacityText(this.laundryCapacityView.women);
            return `남 ${men} · 여 ${women}`;
        },

        homeLaundryTone(this: any) {
            if (this.laundryState === 'error') return 'danger';
            if (this.laundryState === 'loading') return 'neutral';
            return this.laundryCapacityView.men === null || this.laundryCapacityView.women === null
                ? 'warning'
                : 'success';
        },

        unreadNotificationCount(this: any) {
            if (this.surface.kind === 'desktop') {
                return this.notificationState === 'loading' && this.dashboardHomeOverview
                    ? this.dashboardHomeOverview.unreadCount
                    : this.desktopNotificationInbox.unreadCount;
            }
            if (this.surface.kind !== 'companion') return 0;
            const seen = new Set(this.seenMobileNotificationIds);
            return this.notifications.filter((notification: DashboardNotification) => !seen.has(notification.id)).length;
        },

        homeNotificationLabel(this: any) {
            if (this.surface.kind === 'public') return '앱에서 사용';
            if (this.notificationState === 'loading') return '확인 중';
            if (this.notificationState === 'error') return '불러오기 실패';
            if (this.notificationState === 'auth-required') return 'PC 연결 필요';
            const unread = this.unreadNotificationCount();
            return unread > 0 ? `안 본 알림 ${unread}개` : '새 알림 없음';
        },

        homeNotificationTone(this: any) {
            if (this.notificationState === 'error') return 'danger';
            return this.unreadNotificationCount() > 0 ? 'warning' : 'neutral';
        },

        desktopNotificationTime(_this: any, createdAt?: number) {
            const epoch = typeof _this === 'number' ? _this : createdAt;
            return epoch === undefined ? '' : notificationTimeLabel(epoch);
        },

        surfaceLabel(this: any) {
            return dashboardSurfaceBadge(this.surface.kind, {
                desktopConnected: this.desktopConnection?.state === 'connected',
                companionAuthenticated: this.attendanceState !== 'auth-required',
            }).label;
        },

        surfaceTone(this: any) {
            return dashboardSurfaceBadge(this.surface.kind, {
                desktopConnected: this.desktopConnection?.state === 'connected',
                companionAuthenticated: this.attendanceState !== 'auth-required',
            }).tone;
        },

        surfaceFooter(this: any) {
            return dashboardSurfaceFooter(this.surface.kind);
        },

        desktopConnectionLabel(this: any) {
            if (this.desktopConnection?.state === 'reset-required') return '재연결 필요';
            if (this.desktopConnection?.state !== 'connected') return '서버 연결 확인';
            if (this.desktopConnection.lmsSessionState === 'connected') return 'LMS 연결됨';
            if (this.desktopConnection.lmsSessionState === 'login-required') return 'LMS 로그인 필요';
            return 'LMS 확인 중';
        },

        desktopConnectionTone(this: any) {
            if (this.desktopConnection?.state === 'reset-required') return 'danger';
            if (this.desktopConnection?.state === 'connected'
                && this.desktopConnection.lmsSessionState === 'connected') return 'success';
            if (this.desktopConnection?.state === 'unknown') return 'neutral';
            return 'warning';
        },

        companionCampusLabel(this: any) {
            const device = this.attendanceDevices[0] as DesktopDevice | undefined;
            if (!device) return 'PC 상태 없음';
            if (device.health === 'offline') return 'PC 오프라인';
            if (device.lmsSessionState === 'connected') return 'LMS 연결됨';
            if (device.lmsSessionState === 'login-required') return 'LMS 로그인 필요';
            return 'LMS 확인 중';
        },

        companionCampusTone(this: any) {
            const device = this.attendanceDevices[0] as DesktopDevice | undefined;
            if (device?.health === 'online' && device.lmsSessionState === 'connected') return 'success';
            if (!device) return 'neutral';
            return 'warning';
        },

        laundrySourceLabel(this: any) {
            if (this.laundryState === 'loading') return '확인 중';
            if (this.laundryState === 'error') return '불러오기 실패';
            if (this.laundryCapacityView.men === null || this.laundryCapacityView.women === null) return '산출 불가';
            return '기기 상태 확인됨';
        },

        laundrySourceTone(this: any) {
            if (this.laundryState === 'error') return 'danger';
            return this.laundryCapacityView.men === null || this.laundryCapacityView.women === null
                ? 'warning'
                : 'success';
        },

        mealsSourceLabel(this: any) {
            if (this.mealsState === 'loading') return '확인 중';
            if (this.mealsState === 'error') return '불러오기 실패';
            return '게시 정보 확인됨';
        },

        capacityText(_this: any, value?: number | null) {
            const count = typeof _this === 'number' || _this === null ? _this : value;
            return count === null || count === undefined ? '산출 불가' : `${count}회`;
        },

        machineNumber(_this: any, id?: string) {
            const value = typeof _this === 'string' ? _this : id;
            return value ? machineNumberValue(value) ?? value : '';
        },

        laundryCellState(_this: any, appliance?: DashboardLaundryAppliance | null) {
            const value = asRecord(_this) && ('operationalStatus' in _this || 'projection' in _this) ? _this : appliance;
            return laundryAvailabilityState(value as DashboardLaundryAppliance | null);
        },

        laundryCellText(_this: any, appliance?: DashboardLaundryAppliance | null) {
            const value = asRecord(_this) && ('operationalStatus' in _this || 'projection' in _this) ? _this : appliance;
            const state = laundryAvailabilityState(value as DashboardLaundryAppliance | null);
            if (state === 'available') return '✓';
            if (state === 'error') return '!';
            return laundryOverviewText(value as DashboardLaundryAppliance | null);
        },

        laundryCellLabel(_this: any, machine?: DashboardLaundryMachine, kind?: 'washer' | 'dryer') {
            const actualMachine = typeof _this?.id === 'string' ? _this : machine;
            const actualKind = typeof machine === 'string' ? machine : kind;
            if (!actualMachine || !actualKind) return '';
            const appliance = actualMachine[actualKind];
            return `${actualMachine.id} ${actualKind === 'washer' ? '세탁기' : '건조기'} ${laundryRemainingText(appliance)}`;
        },

        todayMeals(this: any) {
            if (!this.mealsSnapshot) return [];
            const daily = this.mealsSnapshot.data.dailyMenus;
            const values = daily.length > 0 ? daily : this.mealsSnapshot.data.pinnedMenus.slice(0, 2);
            return sortMealPostsByPeriod(values).slice(0, 4);
        },

        recentMeals(this: any) {
            if (!this.mealsSnapshot) return [];
            const currentIds = new Set(this.todayMeals().map((meal: DashboardMealPost) => meal.id));
            return this.mealsSnapshot.data.recentMenus.filter((meal: DashboardMealPost) => !currentIds.has(meal.id)).slice(0, 8);
        },

        mealPeriod(_this: any, meal?: DashboardMealPost) {
            const value = typeof _this?.title !== 'undefined' ? _this as DashboardMealPost : meal;
            if (value?.title?.includes('중식')) return '중식';
            if (value?.title?.includes('석식')) return '석식';
            return '식단';
        },

        deviceStatusLabel(_this: any, device?: DesktopDevice) {
            const value = typeof _this?.health === 'string' ? _this as DesktopDevice : device;
            if (!value) return '';
            const health = value.health === 'online' ? '온라인' : value.health === 'offline' ? '오프라인' : '상태 미확인';
            const lms = value.lmsSessionState === 'connected' ? 'LMS 연결됨' : value.lmsSessionState === 'login-required' ? 'LMS 로그인 필요' : 'LMS 상태 미확인';
            return `${health} · ${lms}`;
        },

        pairingLabel(this: any) {
            if (this.desktopPairingStatus?.status === 'claimed') return '승인 필요';
            if (this.desktopPairingStatus?.status === 'approved') return '승인됨';
            if (this.desktopPairingStatus?.status === 'completed') return '연결 완료';
            if (this.desktopPairingStatus?.status === 'expired') return '만료됨';
            return this.desktopPairing ? '대기 중' : '코드 없음';
        },

        pairingTone(this: any) {
            if (this.desktopPairingStatus?.status === 'completed') return 'success';
            if (this.desktopPairingStatus?.status === 'expired') return 'danger';
            if (this.desktopPairingStatus?.status === 'claimed') return 'warning';
            return 'neutral';
        },

        formattedDesktopPairingCode(this: any) {
            return this.desktopPairing ? formatManualPairingCode(this.desktopPairing.manualCode) : '';
        },

        mobilePairingLabel(this: any) {
            const labels: Record<MobilePairingViewState, string> = {
                manual: '연결 전', claiming: '요청 중', waiting: '승인 대기', completed: '연결됨', expired: '만료됨', error: '확인 필요',
            };
            return labels[this.mobilePairingState as MobilePairingViewState];
        },

        mobilePairingTone(this: any) {
            if (this.mobilePairingState === 'completed') return 'success';
            if (this.mobilePairingState === 'expired' || this.mobilePairingState === 'error') return 'danger';
            if (this.mobilePairingState === 'waiting') return 'warning';
            return 'neutral';
        },

        pushLabel(this: any) {
            if (this.surface.kind === 'desktop') return '운영체제 알림';
            if (this.pushPermission === 'granted') return '허용됨';
            if (this.pushPermission === 'denied') return '차단됨';
            if (this.pushPermission === 'unsupported') return '지원 안 함';
            return '설정 전';
        },

        pushTone(this: any) {
            if (this.surface.kind === 'desktop') return 'neutral';
            if (this.pushPermission === 'granted') return 'success';
            if (this.pushPermission === 'denied') return 'danger';
            return 'neutral';
        },

        notificationStateLabel(this: any) {
            if (this.notificationState === 'loading') return '확인 중';
            if (this.notificationState === 'error') return '불러오기 실패';
            if (this.notificationState === 'auth-required') return '연결 필요';
            if (this.surface.kind === 'desktop') return `${this.desktopNotificationInbox.items.length}건`;
            return `${this.notifications.length}건`;
        },

        notificationStateTone(this: any) {
            if (this.notificationState === 'error') return 'danger';
            if (this.notificationState === 'auth-required') return 'warning';
            const count = this.surface.kind === 'desktop'
                ? this.desktopNotificationInbox.items.length
                : this.notifications.length;
            return count > 0 ? 'success' : 'neutral';
        },

        notificationImportance(_this: any, notification?: DashboardNotification) {
            const value = typeof _this?.kind === 'string' ? _this as DashboardNotification : notification;
            return value?.kind === 'attendance-action-required' || value?.kind === 'login-required'
                ? 'important'
                : 'normal';
        },

        openNotification(this: any, notification: DashboardNotification) {
            this.markMobileNotificationsSeen();
            const route = notification.path.slice(notification.path.indexOf('#') + 1) as DashboardRoute;
            this.selectRoute(route);
        },

        formatEpochDateTime(_this: any, value?: number) {
            const epoch = typeof _this === 'number' ? _this : value;
            if (epoch === undefined || !Number.isSafeInteger(epoch)) return '확인 중';
            return new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul',
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).format(new Date(epoch));
        },

        epochIso(_this: any, value?: number) {
            const epoch = typeof _this === 'number' ? _this : value;
            return epoch !== undefined && Number.isSafeInteger(epoch) ? new Date(epoch).toISOString() : '';
        },

        formatDate(_this: any, value?: string | null) {
            const source = typeof _this === 'string' || _this === null ? _this : value;
            if (!source || !Number.isFinite(Date.parse(source))) return '확인 중';
            return new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
            }).format(new Date(source));
        },

        formatDateTime(_this: any, value?: string | null) {
            const source = typeof _this === 'string' || _this === null ? _this : value;
            if (!source || !Number.isFinite(Date.parse(source))) return '확인 중';
            return new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            }).format(new Date(source));
        },

        relativeTime(_this: any, value?: string | null) {
            const source = typeof _this === 'string' || _this === null ? _this : value;
            if (!source || !Number.isFinite(Date.parse(source))) return '확인 전';
            const minutes = Math.max(0, Math.round((Date.now() - Date.parse(source)) / 60_000));
            if (minutes < 1) return '방금';
            if (minutes < 60) return `${minutes}분 전`;
            if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
            return `${Math.floor(minutes / (24 * 60))}일 전`;
        },
    };
}

Alpine.data('dashboard', dashboard);
Alpine.start();
