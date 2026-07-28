import Alpine from 'alpinejs';
import anchor from '@alpinejs/anchor';
import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {message} from '@tauri-apps/plugin-dialog';
import {openUrl} from '@tauri-apps/plugin-opener';
import {dismissInfoDisclosures, infoDisclosure, type InfoDisclosure} from './info-disclosure';
import {
    laundryAvailabilityState,
    laundryOperationLabel,
    laundryOverviewText,
    laundryProgress,
    laundryRemainingText,
    laundryStartAt,
    laundryZoneMatchesAccess,
    summarizeLaundryAvailability,
} from './laundry-status';
import {
    assessLaundryAccessSituation,
    laundrySituationDataIsReliable,
    type LaundryAccessSituation,
    type LaundrySituationMachine,
    type LaundrySituationState,
} from './laundry-situation';
import {relativeTimeKo} from './live-time';
import {sortMealPostsByPeriod} from './meal-display';
import {isSafeImageAssetUrl} from './image-asset-url';
import {
    connectSettingsSnapshots,
    invokeSettingsMutation,
    type LaundryWatch,
    type SettingsSnapshot,
} from './settings-state';

Alpine.plugin(anchor);

type CampusTab = 'laundry' | 'meals';
type MealView = 'current' | 'history';
type LaundryFilter = 'all' | 'washerAvailable' | 'dryerAvailable';
type LaundryAccess = 'all' | 'men' | 'women';
type MachineZone = 'men' | 'common' | 'women' | 'other';
type ApplianceKind = 'washer' | 'dryer';
type AvailabilityState = 'available' | 'error' | 'unavailable';
type Tone = 'neutral' | 'normal' | 'success' | 'warning' | 'danger' | 'complete';
type CampusInteraction =
    | {action: 'laundry_tab_selected'}
    | {action: 'meals_tab_selected'}
    | {action: 'laundry_access_changed'; value: LaundryAccess}
    | {action: 'laundry_filter_changed'; value: 'all' | 'washer_available' | 'dryer_available'}
    | {action: 'meal_history_opened'}
    | {action: 'meal_calendar_navigated'; value: 'previous' | 'next'}
    | {action: 'meal_post_opened'}
    | {action: 'meal_image_opened'}
    | {action: 'laundry_refresh_requested'}
    | {action: 'meals_refresh_requested'};

interface Projection {
    status?: string;
    statusLabelKo?: string;
    remainingMinutes?: number;
    estimated?: boolean;
}

interface Appliance {
    machineId?: string;
    appliance?: string;
    operationalStatus?: string;
    operationalStatusLabelKo?: string;
    projection?: Projection;
    state?: {code?: string; labelKo?: string} | null;
    totalMinutes?: number;
    startedAt?: string | null;
    estimatedFinishAt?: string | null;
    observedAt?: string;
    sessionId?: string | null;
    errorCode?: string;
}

interface Machine {
    id: string;
    washer?: Appliance | null;
    dryer?: Appliance | null;
}

interface LaundryEvent {
    machineId?: string;
    appliance?: string;
    sessionId?: string | null;
    observedAt: string;
    type: string;
    etaDeltaMinutes?: number;
    detail?: {previousTotalMinutes?: number; currentTotalMinutes?: number};
}

interface LaundryData {
    schemaVersion: number;
    machines: Machine[];
    events?: LaundryEvent[];
    quality?: {
        sourceFreshness?: string;
        sourceFreshnessLabelKo?: string;
        lastCheckedAt?: string;
    };
}

interface MealPost {
    id?: string;
    contentSha: string;
    title?: string;
    text?: string;
    publishedAt?: string;
    updatedAt?: string;
    firstSeenAt?: string;
    permalink?: string;
    images?: Array<{url?: string; width?: number; height?: number}>;
}

interface MealsData {
    schemaVersion: number;
    dailyMenus: MealPost[];
    pinnedMenus: MealPost[];
    currentWeeklyMenu: CurrentWeeklyMealMenu;
    weeklyMenus?: WeeklyMealMenu[];
    recentMenus?: MealPost[];
    historyNextBefore?: string | null;
}

interface WeeklyMealMenu {
    weekKey: string;
    contentSha: string;
    post: MealPost;
}

interface CurrentWeeklyMealMenu {
    targetWeekKey: string;
    status: 'AVAILABLE' | 'AWAITING_UPDATE';
    contentSha: string | null;
    post: MealPost | null;
}

interface MealHistoryPage {
    posts: MealPost[];
    nextBefore: string | null;
}

interface MealCalendarDay {
    key: string;
    day: number;
    weekday: number;
    inCurrentMonth: boolean;
    isToday: boolean;
    posts: MealPost[];
}

interface MealsPayload {
    lastCheckedAt?: string;
    data: MealsData;
}

interface CampusSnapshot {
    savedAt: number;
    data: unknown;
}

interface CampusUpdate {
    kind: CampusTab;
    snapshot: CampusSnapshot;
}

interface CampusError {
    kind: CampusTab;
    message: string;
}

interface SourceState {
    label: string;
    tone: Tone;
}

interface StatusView {
    label: string;
    tone: Tone;
}

interface ApplianceError {
    code: string;
    label: string;
}

interface TypeSummary {
    total: number;
    available: number;
}

interface LaundryPreferences {
    access: LaundryAccess;
    filter: LaundryFilter;
}

interface AvailabilitySegment {
    id: string;
    number: number;
    zone: MachineZone;
    state: AvailabilityState;
    overviewText: string;
    label: string;
}

interface LaundryAlertOption {
    value: string;
    label: string;
    machineId: string;
    appliance: ApplianceKind;
    sessionId: string;
}

const ACTIVE_STATUSES = new Set(['RUNNING', 'PAUSED', 'SCHEDULED']);
const SIGNIFICANT_ETA_CHANGE_MINUTES = 5;
const WASH_TOWER_COUNT = 9;
const LAUNDRY_PREFERENCES_KEY = 'jungle-bell:campus:laundry-preferences';
const CAMPUS_RECOVERY_INTERVAL_MS = 10_000;
const LAUNDRY_NOTICE_MINUTES = [1, 3, 5, 10, 15, 30] as const;
const KST_TIME_ZONE = 'Asia/Seoul';
const APPLIANCE_ERROR_LABELS: Record<string, string> = {
    EMPTY_WATER_ALERT_ERROR: '배관 에러',
};
const PROJECTION_LABELS: Record<string, string> = {
    OBSERVED: '관측값', ESTIMATED_RUNNING: '작동 중', AWAITING_COMPLETION_CONFIRMATION: '완료 확인 중',
    CONFIRMED_COMPLETED: '완료', PAUSED: '일시 정지', ERROR: '오류', IDLE: '사용 가능', UNKNOWN: '확인 불가',
};
const LAUNDRY_SITUATION_STATE_LABELS: Record<LaundrySituationState, string> = {
    checking: '현황 확인 중',
    limited: '자리 부족',
    dryerBottleneck: '건조 대기 예상',
    comfortable: '널널함',
    available: '이용 가능',
};
const LAUNDRY_SITUATION_RECOMMENDATION_LABELS: Record<LaundrySituationState, string> = {
    checking: '현황 확인 중이에요. 잠시 후 다시 봐 주세요.',
    limited: '자리가 금방 찰 수 있어 조금 기다리는 게 좋아요.',
    dryerBottleneck: '세탁 후 건조기가 부족할 수 있어 기다리는 게 좋아요.',
    comfortable: '여러 대가 남아 있어 시작해도 괜찮을 것 같아요.',
    available: '한 대를 써도 여유가 남아 시작해도 괜찮을 것 같아요.',
};
const LAUNDRY_FILTER_ANALYTICS_VALUES = {
    all: 'all',
    washerAvailable: 'washer_available',
    dryerAvailable: 'dryer_available',
} as const satisfies Record<LaundryFilter, string>;

function reportCampusInteraction(interaction: CampusInteraction): void {
    void invoke('report_campus_interaction', {interaction})
        .catch((error) => console.error('[campus] analytics report failed', error));
}

function machineNumber(id: string): number | null {
    const match = String(id ?? '').trim().match(/(?:워시타워[_\s-]*)?(\d+)$/);
    return match?.[1] ? Number(match[1]) : null;
}

function machineZone(id: string): MachineZone {
    const number = machineNumber(id);
    if (number !== null && number >= 1 && number <= 5) return 'men';
    if (number !== null && number >= 6 && number <= 7) return 'common';
    if (number !== null && number >= 8 && number <= 9) return 'women';
    return 'other';
}

function isLaundryAccess(value: unknown): value is LaundryAccess {
    return value === 'all' || value === 'men' || value === 'women';
}

function isLaundryFilter(value: unknown): value is LaundryFilter {
    return value === 'all' || value === 'washerAvailable' || value === 'dryerAvailable';
}

function loadLaundryPreferences(): LaundryPreferences {
    const defaults: LaundryPreferences = {access: 'all', filter: 'all'};
    try {
        const raw = window.localStorage.getItem(LAUNDRY_PREFERENCES_KEY);
        if (!raw) return defaults;
        const value = JSON.parse(raw) as Partial<LaundryPreferences> | null;
        return {
            access: isLaundryAccess(value?.access) ? value.access : defaults.access,
            filter: isLaundryFilter(value?.filter) ? value.filter : defaults.filter,
        };
    } catch {
        return defaults;
    }
}

function saveLaundryPreferences(preferences: LaundryPreferences): void {
    try {
        window.localStorage.setItem(LAUNDRY_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
        // The filters remain usable for the current session when storage is unavailable.
    }
}

declare global {
    interface Window {
        setCampusTab?: (tab: string) => void;
    }
}

function initialTab(): CampusTab {
    return new URLSearchParams(window.location.search).get('tab') === 'meals' ? 'meals' : 'laundry';
}

function kstDateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: KST_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function isMealServiceDate(dateKey: string): boolean {
    return new Date(`${dateKey}T00:00:00Z`).getUTCDay() !== 0;
}

function weekMondayKey(dateKey: string): string {
    const date = new Date(`${dateKey}T00:00:00Z`);
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return date.toISOString().slice(0, 10);
}

function sourceMealWeekLabel(post?: MealPost | null): string {
    // Kakao meal posts start week 1 on the month's first full Monday; keep that title instead of recalculating a KS week number.
    return post?.title?.match(/\d{1,2}월\s*\d{1,2}주차/)?.[0] ?? '';
}

function projectCampusSettings(target: any, snapshot: SettingsSnapshot): void {
    target.laundryWatch = snapshot.laundryWatch;
}

function campus(): Record<string, unknown> {
    const laundryPreferences = loadLaundryPreferences();

    return {
        activeTab: initialTab() as CampusTab,
        mealView: 'current' as MealView,
        laundryFilter: laundryPreferences.filter,
        laundryAccess: laundryPreferences.access,
        laundry: null as LaundryData | null,
        laundrySnapshotSavedAt: null as number | null,
        meals: null as MealsPayload | null,
        settingsRevision: -1,
        laundryWatch: null as LaundryWatch | null,
        subscriptionBusy: false,
        laundryAlertSelection: '',
        laundryAlertNotice: 5,
        laundryNoticeMinutes: [...LAUNDRY_NOTICE_MINUTES],
        mealHistory: [] as MealPost[],
        mealHistoryNextBefore: null as string | null,
        mealHistoryInitialized: false,
        mealHistoryLoading: false,
        mealHistoryError: null as string | null,
        mealCalendarMonth: kstDateKey(new Date()).slice(0, 7),
        mealSelectedDate: kstDateKey(new Date()),
        retrying: false,
        clockNow: Date.now(),
        clockTimer: null as number | null,
        recoveryTimer: null as number | null,
        onlineRecoveryHandler: null as (() => void) | null,
        refreshInFlight: {laundry: false, meals: false} as Record<CampusTab, boolean>,
        source: {
            laundry: {label: '세탁기 정보 확인 중', tone: 'neutral'},
            meals: {label: '식단 정보 확인 중', tone: 'neutral'},
        } as Record<CampusTab, SourceState>,
        errors: {laundry: null, meals: null} as Record<CampusTab, string | null>,
        unlisteners: [] as UnlistenFn[],

        async init(this: any) {
            this.clockTimer = window.setInterval(() => {
                this.clockNow = Date.now();
            }, 1000);
            this.onlineRecoveryHandler = () => {
                void this.recoverMissingData();
            };
            window.addEventListener('online', this.onlineRecoveryHandler);
            this.recoveryTimer = window.setInterval(() => {
                void this.recoverMissingData();
            }, CAMPUS_RECOVERY_INTERVAL_MS);
            this.$watch('laundryAccess', (value: LaundryAccess, previous: LaundryAccess) => {
                saveLaundryPreferences({access: value, filter: this.laundryFilter});
                if (value !== previous) reportCampusInteraction({action: 'laundry_access_changed', value});
            });
            this.$watch('laundryFilter', (value: LaundryFilter, previous: LaundryFilter) => {
                saveLaundryPreferences({access: this.laundryAccess, filter: value});
                if (value !== previous) {
                    reportCampusInteraction({
                        action: 'laundry_filter_changed',
                        value: LAUNDRY_FILTER_ANALYTICS_VALUES[value],
                    });
                }
            });
            window.setCampusTab = (tab) => {
                if (tab === 'laundry' || tab === 'meals') this.selectTab(tab);
            };
            try {
                this.unlisteners.push(await listen<CampusUpdate>('campus-data-updated', (event) => {
                    this.applySnapshot(event.payload);
                }));
                this.unlisteners.push(await listen<CampusError>('campus-data-error', (event) => {
                    this.applyError(event.payload);
                }));
                this.unlisteners.push(await listen<MealHistoryPage>('meal-history-updated', (event) => {
                    this.applyMealHistoryPage(event.payload);
                }));
                const unlistenSettings = await connectSettingsSnapshots(
                    this,
                    projectCampusSettings,
                    (context, error) => console.error(`[campus] settings ${context} failed`, error),
                );
                if (unlistenSettings) this.unlisteners.push(unlistenSettings);
                await invoke('report_campus_ready');
                await this.recoverMissingData();
            } catch (error) {
                console.error('[campus] Rust state connection failed', error);
                this.applyError({kind: this.activeTab, message: String(error)});
            }
        },

        destroy(this: any) {
            if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
            this.clockTimer = null;
            if (this.recoveryTimer !== null) window.clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
            if (this.onlineRecoveryHandler) window.removeEventListener('online', this.onlineRecoveryHandler);
            this.onlineRecoveryHandler = null;
            this.unlisteners.forEach((unlisten: UnlistenFn) => unlisten());
            this.unlisteners = [];
            delete window.setCampusTab;
        },

        selectTab(this: any, tab: CampusTab) {
            const changed = this.activeTab !== tab;
            dismissInfoDisclosures();
            this.activeTab = tab;
            const url = new URL(window.location.href);
            url.searchParams.set('tab', tab);
            window.history.replaceState(null, '', url);
            if (changed) {
                reportCampusInteraction({
                    action: tab === 'laundry' ? 'laundry_tab_selected' : 'meals_tab_selected',
                });
            }
            void this.recoverMissingData();
        },

        laundryAlertOptions(this: any): LaundryAlertOption[] {
            if (!this.laundry) return [];
            const options: LaundryAlertOption[] = [];
            for (const machine of this.laundry.machines as Machine[]) {
                if (!laundryZoneMatchesAccess(machineZone(machine.id), this.laundryAccess)) continue;
                for (const appliance of ['dryer', 'washer'] as const) {
                    const state = machine[appliance];
                    if (!state?.sessionId || (!this.applianceIsActive(state) && !this.applianceHasError(state))) {
                        continue;
                    }
                    const status = this.applianceHasError(state)
                        ? this.projectionView(state).label
                        : this.remainingText(state);
                    options.push({
                        value: `${machine.id}:${appliance}:${state.sessionId}`,
                        label: `${this.machineName(machine.id)} ${appliance === 'washer' ? '세탁기' : '건조기'}(${this.machineZoneLabel(machine.id)}) · ${status}`,
                        machineId: machine.id,
                        appliance,
                        sessionId: state.sessionId,
                    });
                }
            }
            return options.sort((left, right) => {
                const leftNumber = machineNumber(left.machineId) ?? Number.MAX_SAFE_INTEGER;
                const rightNumber = machineNumber(right.machineId) ?? Number.MAX_SAFE_INTEGER;
                if (leftNumber !== rightNumber) return leftNumber - rightNumber;
                return left.appliance === right.appliance ? 0 : left.appliance === 'dryer' ? -1 : 1;
            });
        },

        openLaundryAlertPicker(this: any) {
            const options = this.laundryAlertOptions() as LaundryAlertOption[];
            const current = options.find((option) => this.laundryWatch
                && option.machineId === this.laundryWatch.machineId
                && option.appliance === this.laundryWatch.appliance
                && option.sessionId === this.laundryWatch.sessionId);
            this.laundryAlertSelection = current?.value ?? options[0]?.value ?? '';
            this.laundryAlertNotice = this.laundryWatch?.notifyBeforeMins ?? 5;
            const dialog = this.$refs.laundryAlertDialog as HTMLDialogElement | undefined;
            if (dialog && !dialog.open) dialog.showModal();
        },

        closeLaundryAlertPicker(this: any) {
            const dialog = this.$refs.laundryAlertDialog as HTMLDialogElement | undefined;
            if (dialog?.open) dialog.close();
        },

        async saveLaundryAlert(this: any) {
            const option = (this.laundryAlertOptions() as LaundryAlertOption[])
                .find((candidate) => candidate.value === this.laundryAlertSelection);
            if (!option || !LAUNDRY_NOTICE_MINUTES.includes(
                this.laundryAlertNotice as typeof LAUNDRY_NOTICE_MINUTES[number],
            )) return;
            const saved = await this.mutateLocalSubscription('set_laundry_watch', {
                watch: {
                    machineId: option.machineId,
                    appliance: option.appliance,
                    sessionId: option.sessionId,
                    notifyBeforeMins: this.laundryAlertNotice,
                },
            });
            if (saved) this.closeLaundryAlertPicker();
        },

        async mutateLocalSubscription(this: any, command: string, args: Record<string, unknown>) {
            if (this.subscriptionBusy) return false;
            this.subscriptionBusy = true;
            try {
                await invokeSettingsMutation(this, projectCampusSettings, command, args);
                return true;
            } catch (error) {
                console.error(`[campus] ${command} failed`, error);
                await message(`설정을 저장하지 못했습니다.\n\n${String(error)}`, {
                    title: '생활 정보 알림',
                    kind: 'error',
                }).catch((dialogError) => console.error('[campus] settings error dialog failed', dialogError));
                return false;
            } finally {
                this.subscriptionBusy = false;
            }
        },

        async clearLaundryWatch(this: any) {
            await this.mutateLocalSubscription('set_laundry_watch', {watch: null});
        },

        async updateLaundryNotice(this: any, value: number) {
            if (!this.laundryWatch || !LAUNDRY_NOTICE_MINUTES.includes(value as typeof LAUNDRY_NOTICE_MINUTES[number])) {
                return;
            }
            await this.mutateLocalSubscription('set_laundry_watch', {
                watch: {...this.laundryWatch, notifyBeforeMins: value},
            });
        },

        watchedLaundryLabel(this: any) {
            if (!this.laundryWatch) return '';
            const appliance = this.laundryWatch.appliance === 'washer' ? '세탁기' : '건조기';
            return `${this.machineName(this.laundryWatch.machineId)} ${appliance}`;
        },

        applySnapshot(this: any, update: CampusUpdate) {
            const {kind, snapshot} = update;
            if (!snapshot || typeof snapshot.savedAt !== 'number') return;
            this.clockNow = Date.now();
            if (kind === 'laundry' && this.isLaundryPayload(snapshot.data)) {
                this.laundry = snapshot.data;
                this.laundrySnapshotSavedAt = snapshot.savedAt;
                this.source.laundry = {
                    label: this.laundry.quality?.lastCheckedAt
                        ? `${this.relativeTime(this.laundry.quality.lastCheckedAt)} 갱신`
                        : '갱신 시각 없음',
                    tone: 'neutral',
                };
            } else if (kind === 'meals' && this.isMealsPayload(snapshot.data)) {
                this.meals = snapshot.data;
                this.initializeMealHistory(this.meals.data);
                this.source.meals = {
                    label: this.meals.lastCheckedAt ? `${this.relativeTime(this.meals.lastCheckedAt)} 갱신` : '갱신 시각 없음',
                    tone: 'neutral',
                };
            } else {
                console.error(`[campus] ${kind} received invalid Rust snapshot`);
                return;
            }
            this.errors[kind] = null;
        },

        applyError(this: any, error: CampusError) {
            if (error.kind !== 'laundry' && error.kind !== 'meals') return;
            this.errors[error.kind] = error.message;
            const hasData = error.kind === 'laundry' ? Boolean(this.laundry) : Boolean(this.meals);
            const label = error.kind === 'laundry' ? '세탁기' : '식단';
            this.source[error.kind] = hasData
                ? {label: '업데이트 실패', tone: 'warning'}
                : {label: '불러오기 실패', tone: 'danger'};
            console.error(`[campus] ${label} source failed`, error.message);
        },

        async retry(this: any) {
            if (this.retrying) return;
            reportCampusInteraction({
                action: this.activeTab === 'laundry'
                    ? 'laundry_refresh_requested'
                    : 'meals_refresh_requested',
            });
            await this.refreshCampusKind(this.activeTab, true);
        },

        async recoverMissingData(this: any) {
            const kind = this.activeTab as CampusTab;
            if (this.hasData(kind)) return;
            await this.refreshCampusKind(kind, false);
        },

        async refreshCampusKind(this: any, kind: CampusTab, showRetrying: boolean) {
            if (this.refreshInFlight[kind]) return;
            this.refreshInFlight[kind] = true;
            if (showRetrying) this.retrying = true;
            try {
                await invoke('refresh_campus_data', {kind});
            } catch (error) {
                console.error(`[campus] ${kind} retry failed`, error);
                this.applyError({kind, message: String(error)});
            } finally {
                this.refreshInFlight[kind] = false;
                if (showRetrying) this.retrying = false;
            }
        },

        hasData(this: any, tab: CampusTab) {
            return tab === 'laundry' ? Boolean(this.laundry) : Boolean(this.meals);
        },

        sourceView(this: any, tab: CampusTab): SourceState {
            const current = this.source[tab] as SourceState;
            if (this.errors[tab] || !this.hasData(tab)) return current;
            const checkedAt = tab === 'laundry'
                ? this.laundry?.quality?.lastCheckedAt
                : this.meals?.lastCheckedAt;
            return {
                ...current,
                label: checkedAt ? `${this.relativeTime(checkedAt)} 갱신` : '갱신 시각 없음',
            };
        },

        isLaundryPayload(data: unknown): data is LaundryData {
            const value = data as Partial<LaundryData> | null;
            return value?.schemaVersion === 1 && Array.isArray(value.machines) && typeof value.quality === 'object';
        },

        isMealsPayload(data: unknown): data is MealsPayload {
            const value = data as Partial<MealsPayload> | null;
            const currentWeekly = value?.data?.currentWeeklyMenu;
            return value?.data?.schemaVersion === 2
                && Array.isArray(value.data.dailyMenus)
                && Array.isArray(value.data.pinnedMenus)
                && currentWeekly !== null
                && typeof currentWeekly === 'object'
                && typeof currentWeekly.targetWeekKey === 'string'
                && (currentWeekly.status === 'AVAILABLE' || currentWeekly.status === 'AWAITING_UPDATE')
                && (currentWeekly.post === null || typeof currentWeekly.post === 'object');
        },

        selectMealView(this: any, view: MealView) {
            const changed = this.mealView !== view;
            this.mealView = view;
            if (changed && view === 'history') reportCampusInteraction({action: 'meal_history_opened'});
            if (view === 'history' && !this.mealHistoryLoading
                && (!this.mealHistoryInitialized || this.mealHistoryNeedsMore())) {
                void this.loadMoreMealHistory();
            }
        },

        initializeMealHistory(this: any, data: MealsData) {
            const latest = [...data.dailyMenus, ...(data.recentMenus ?? [])];
            if (!this.mealHistoryInitialized) {
                this.mealHistory = this.uniqueMealPosts(latest);
                this.mealHistoryNextBefore = data.historyNextBefore ?? null;
                this.mealHistoryInitialized = true;
                return;
            }
            this.mealHistory = this.uniqueMealPosts([...latest, ...this.mealHistory]);
        },

        uniqueMealPosts(this: any, posts: MealPost[]): MealPost[] {
            const seen = new Set<string>();
            return posts.filter((post, index) => {
                const key = this.postIdentity(post, index);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        },

        applyMealHistoryPage(this: any, page: MealHistoryPage) {
            if (!page || !Array.isArray(page.posts)) return;
            this.mealHistory = this.uniqueMealPosts([...this.mealHistory, ...page.posts]);
            this.mealHistoryNextBefore = page.nextBefore ?? null;
            this.mealHistoryInitialized = true;
            this.mealHistoryLoading = false;
            this.mealHistoryError = null;
            if (this.mealHistoryNeedsMore()) void this.loadMoreMealHistory();
        },

        async loadMoreMealHistory(this: any) {
            if (this.mealHistoryLoading) return;
            if (this.mealHistoryInitialized && !this.mealHistoryNextBefore) return;
            this.mealHistoryLoading = true;
            this.mealHistoryError = null;
            try {
                await invoke('load_meal_history', {before: this.mealHistoryNextBefore});
            } catch (error) {
                console.error('[campus] meal history request failed', error);
                this.mealHistoryLoading = false;
                this.mealHistoryError = String(error);
            }
        },

        mealHistoryNeedsMore(this: any) {
            if (!this.mealHistoryNextBefore) return false;
            const oldest = this.mealHistory
                .map((post: MealPost) => this.postDateKey(post))
                .filter(Boolean)
                .sort()[0];
            return !oldest || oldest > `${this.mealCalendarMonth}-01`;
        },

        moveMealMonth(this: any, offset: number) {
            const [year, month] = this.mealCalendarMonth.split('-').map(Number);
            const target = new Date(Date.UTC(year, month - 1 + offset, 1));
            this.mealCalendarMonth = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;
            this.mealSelectedDate = `${this.mealCalendarMonth}-01`;
            reportCampusInteraction({
                action: 'meal_calendar_navigated',
                value: offset < 0 ? 'previous' : 'next',
            });
            if (this.mealHistoryNeedsMore()) void this.loadMoreMealHistory();
        },

        canMoveMealMonthNext(this: any) {
            return this.mealCalendarMonth < kstDateKey(new Date()).slice(0, 7);
        },

        mealCalendarLabel(this: any) {
            const [year, month] = this.mealCalendarMonth.split('-').map(Number);
            return new Intl.DateTimeFormat('ko-KR', {year: 'numeric', month: 'long'})
                .format(new Date(Date.UTC(year, month - 1, 1)));
        },

        mealCalendarDays(this: any): MealCalendarDay[] {
            const [year, month] = this.mealCalendarMonth.split('-').map(Number);
            const first = new Date(Date.UTC(year, month - 1, 1));
            const calendarStart = new Date(first);
            calendarStart.setUTCDate(1 - first.getUTCDay());
            const postsByDate = new Map<string, MealPost[]>();
            for (const post of this.mealHistory as MealPost[]) {
                const key = this.postDateKey(post);
                if (!key) continue;
                const posts = postsByDate.get(key) ?? [];
                posts.push(post);
                postsByDate.set(key, posts);
            }
            const today = kstDateKey(new Date());
            return Array.from({length: 42}, (_, index) => {
                const date = new Date(calendarStart);
                date.setUTCDate(calendarStart.getUTCDate() + index);
                const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
                return {
                    key,
                    day: date.getUTCDate(),
                    weekday: date.getUTCDay(),
                    inCurrentMonth: date.getUTCMonth() === month - 1,
                    isToday: key === today,
                    posts: sortMealPostsByPeriod(postsByDate.get(key) ?? []),
                };
            });
        },

        mealCalendarWeeks(this: any): MealCalendarDay[][] {
            const days = this.mealCalendarDays() as MealCalendarDay[];
            return Array.from({length: 6}, (_, index) => days.slice(index * 7, index * 7 + 7));
        },

        selectMealDate(this: any, day: MealCalendarDay) {
            this.mealSelectedDate = day.key;
            this.mealCalendarMonth = day.key.slice(0, 7);
            if (this.mealHistoryNeedsMore()) void this.loadMoreMealHistory();
        },

        selectedMealPosts(this: any): MealPost[] {
            return sortMealPostsByPeriod(
                (this.mealHistory as MealPost[])
                    .filter((post) => this.postDateKey(post) === this.mealSelectedDate),
            );
        },

        mealsServedToday() {
            return isMealServiceDate(kstDateKey(new Date()));
        },

        selectedMealDateIsSunday(this: any) {
            return !isMealServiceDate(this.mealSelectedDate);
        },

        selectedWeeklyMenu(this: any): MealPost | null {
            const menus = new Map<string, WeeklyMealMenu>(
                (this.meals?.data.weeklyMenus ?? []).map((menu: WeeklyMealMenu) => [menu.weekKey, menu]),
            );
            return menus.get(weekMondayKey(this.mealSelectedDate))?.post ?? null;
        },

        currentWeeklyMenu(this: any): MealPost | null {
            return this.meals?.data.currentWeeklyMenu?.post ?? null;
        },

        selectedMealWeekLabel(this: any) {
            return sourceMealWeekLabel(this.selectedWeeklyMenu());
        },

        selectedMealDateLabel(this: any) {
            const [year, month, day] = this.mealSelectedDate.split('-').map(Number);
            return new Intl.DateTimeFormat('ko-KR', {month: 'long', day: 'numeric', weekday: 'long'})
                .format(new Date(Date.UTC(year, month - 1, day)));
        },

        postDateKey(this: any, post: MealPost) {
            const parsed = this.parseDate(post.publishedAt ?? post.firstSeenAt);
            return parsed ? kstDateKey(parsed) : null;
        },

        mealPeriodLabel(post: MealPost) {
            if (post.title?.includes('중식')) return '중식';
            if (post.title?.includes('석식')) return '석식';
            return '식단';
        },

        mealPeriodKind(post: MealPost) {
            return post.title?.includes('석식') ? 'dinner' : 'lunch';
        },

        typeSummary(this: any, kind: ApplianceKind): TypeSummary {
            return summarizeLaundryAvailability(this.availabilitySegments(kind), this.laundryAccess);
        },

        laundrySituationMachines(this: any): LaundrySituationMachine[] {
            return Array.from({length: WASH_TOWER_COUNT}, (_, index) => {
                const number = index + 1;
                const machine = this.laundry?.machines.find(
                    (item: Machine) => machineNumber(item.id) === number,
                );
                return {
                    zone: machineZone(String(number)),
                    washer: machine?.washer,
                    dryer: machine?.dryer,
                };
            });
        },

        laundryAccessSituations(this: any): LaundryAccessSituation[] {
            const reliable = laundrySituationDataIsReliable({
                hasData: Boolean(this.laundry),
                error: this.errors.laundry,
                sourceFreshness: this.laundry?.quality?.sourceFreshness,
                snapshotSavedAt: this.laundrySnapshotSavedAt,
                nowMs: this.clockNow,
            });
            const machines = this.laundrySituationMachines();
            return [
                assessLaundryAccessSituation(machines, 'men', reliable),
                assessLaundryAccessSituation(machines, 'women', reliable),
            ];
        },

        laundrySituationAccessLabel(situation: LaundryAccessSituation): string {
            return situation.access === 'men' ? '남성 가능' : '여성 가능';
        },

        laundrySituationStateLabel(situation: LaundryAccessSituation): string {
            return LAUNDRY_SITUATION_STATE_LABELS[situation.state];
        },

        laundrySituationRecommendationLabel(situation: LaundryAccessSituation): string {
            return LAUNDRY_SITUATION_RECOMMENDATION_LABELS[situation.state];
        },

        availabilitySegments(this: any, kind: ApplianceKind): AvailabilitySegment[] {
            if (!this.laundry) return [];
            return Array.from({length: WASH_TOWER_COUNT}, (_, index) => {
                const number = index + 1;
                const machine = this.laundry.machines.find((item: Machine) => machineNumber(item.id) === number);
                const appliance = machine?.[kind];
                const zone = machineZone(String(number));
                const state: AvailabilityState = laundryAvailabilityState(appliance);
                const zoneLabel = this.machineZoneLabel(String(number));
                const stateLabel = appliance ? this.projectionView(appliance).label : '정보 없음';
                return {
                    id: `${number}-${kind}`,
                    number,
                    zone,
                    state,
                    overviewText: laundryOverviewText(appliance, this.clockNow),
                    label: `${number}번 워시타워 ${zoneLabel} ${kind === 'washer' ? '세탁기' : '건조기'} ${stateLabel}`,
                };
            });
        },

        filteredMachines(this: any): Machine[] {
            if (!this.laundry) return [];
            return [...this.laundry.machines]
                .filter((machine) => {
                    const zone = machineZone(machine.id);
                    if (!laundryZoneMatchesAccess(zone, this.laundryAccess)) return false;
                    if (this.laundryFilter === 'washerAvailable') return this.applianceIsAvailable(machine.washer);
                    if (this.laundryFilter === 'dryerAvailable') return this.applianceIsAvailable(machine.dryer);
                    return true;
                })
                .sort((left, right) => {
                    const leftNumber = machineNumber(left.id);
                    const rightNumber = machineNumber(right.id);
                    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
                        return leftNumber - rightNumber;
                    }
                    if (leftNumber !== null) return -1;
                    if (rightNumber !== null) return 1;
                    return String(left.id).localeCompare(String(right.id), 'ko', {numeric: true});
                });
        },

        laundryEmptyMessage(this: any) {
            if (this.laundryAccess !== 'all') return '선택한 이용 구역에서 조건에 맞는 워시타워가 없습니다.';
            return this.laundryFilter === 'all'
                ? '표시할 워시타워가 없습니다.'
                : '선택한 조건에 맞는 사용 가능한 워시타워가 없습니다.';
        },

        applianceIsActive(appliance?: Appliance | null) {
            return Boolean(appliance && (ACTIVE_STATUSES.has(appliance.operationalStatus ?? '')
                || appliance.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION'));
        },

        applianceIsAvailable(appliance?: Appliance | null) {
            return laundryAvailabilityState(appliance) === 'available';
        },
        applianceHasError(appliance?: Appliance | null) {
            return laundryAvailabilityState(appliance) === 'error';
        },

        completionConfirmationDelayed(this: any, appliance?: Appliance | null) {
            if (appliance?.projection?.status !== 'AWAITING_COMPLETION_CONFIRMATION') return false;
            const finishAt = this.parseDate(appliance.estimatedFinishAt);
            return Boolean(finishAt && this.clockNow > finishAt.getTime());
        },

        machineName(id: string) {
            const text = String(id ?? '').trim();
            const number = machineNumber(text);
            return number !== null ? `${number}번` : text.replaceAll('_', ' ');
        },

        machineZoneLabel(id: string) {
            return ({men: '남성', common: '공용', women: '여성', other: '기타'} as Record<MachineZone, string>)[machineZone(id)];
        },

        machineZone(id: string) { return machineZone(id); },

        applianceError(appliance?: Appliance | null): ApplianceError | null {
            const code = appliance?.errorCode?.trim().toUpperCase();
            if (!code) return null;
            const label = APPLIANCE_ERROR_LABELS[code] ?? '기기 오류';
            return {code, label};
        },

        projectionView(this: any, appliance?: Appliance | null): StatusView {
            if (!appliance) return {label: '정보 없음', tone: 'neutral'};
            const status = appliance.projection?.status;
            const label = appliance.projection?.statusLabelKo ?? PROJECTION_LABELS[status ?? ''];
            if (status === 'AWAITING_COMPLETION_CONFIRMATION') {
                return this.completionConfirmationDelayed(appliance)
                    ? {label: '완료 확인 지연', tone: 'warning'}
                    : {label: '완료 확인 중', tone: 'normal'};
            }
            if (status === 'CONFIRMED_COMPLETED') return {label: label ?? '완료', tone: 'complete'};
            if (status === 'PAUSED') return {label: label ?? '일시 정지', tone: 'warning'};
            if (status === 'ERROR') return {label: this.applianceError(appliance)?.label ?? label ?? '오류', tone: 'danger'};
            if (status === 'UNKNOWN') return {label: label ?? '확인 불가', tone: 'neutral'};
            if (appliance.operationalStatus === 'SCHEDULED') return {label: appliance.operationalStatusLabelKo ?? '예약됨', tone: 'normal'};
            if (status === 'IDLE') return {label: label ?? '사용 가능', tone: 'success'};
            const stateLabel = laundryOperationLabel(appliance);
            if (appliance.operationalStatus === 'RUNNING') return {label: stateLabel ?? '작동 중', tone: 'normal'};
            return {
                label: stateLabel ?? label ?? appliance.operationalStatusLabelKo ?? '작동 중',
                tone: 'normal',
            };
        },

        remainingText(this: any, appliance?: Appliance | null) {
            return laundryRemainingText(appliance, this.clockNow);
        },

        startAt(appliance?: Appliance | null) {
            return laundryStartAt(appliance);
        },

        progress(this: any, appliance?: Appliance | null) {
            if (!this.applianceIsActive(appliance) && !this.applianceHasError(appliance)) return null;
            return laundryProgress(appliance, this.clockNow);
        },

        adjustmentMessage(this: any, appliance?: Appliance | null) {
            if (!appliance?.sessionId || !this.laundry) return null;
            const matching = (this.laundry.events ?? [])
                .filter((event: LaundryEvent) => event.machineId === appliance.machineId
                    && event.appliance === appliance.appliance
                    && event.sessionId === appliance.sessionId)
                .sort((left: LaundryEvent, right: LaundryEvent) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
            const current = matching.find((event: LaundryEvent) => {
                if (event.type === 'ETA_EXTENDED' || event.type === 'ETA_REDUCED') {
                    return Math.abs(event.etaDeltaMinutes ?? 0) >= SIGNIFICANT_ETA_CHANGE_MINUTES;
                }
                if (event.type !== 'TOTAL_TIME_ADJUSTED') return false;
                const previous = event.detail?.previousTotalMinutes;
                const next = event.detail?.currentTotalMinutes;
                return Number.isFinite(previous) && Number.isFinite(next)
                    && Math.abs((next as number) - (previous as number)) >= SIGNIFICANT_ETA_CHANGE_MINUTES;
            });
            if (!current) return null;
            const delta = Math.abs(Math.round(current.etaDeltaMinutes ?? 0));
            if (current.type === 'ETA_EXTENDED') return `예상 종료가 ${delta}분 늦어졌습니다.`;
            if (current.type === 'ETA_REDUCED') return `예상 종료가 ${delta}분 빨라졌습니다.`;
            if (current.type === 'TOTAL_TIME_ADJUSTED') {
                const previous = current.detail?.previousTotalMinutes;
                const next = current.detail?.currentTotalMinutes;
                return Number.isFinite(previous) && Number.isFinite(next)
                    ? `전체 시간이 ${previous}분에서 ${next}분으로 조정됐습니다.` : '전체 시간이 조정됐습니다.';
            }
            return null;
        },

        applianceInfo(this: any, appliance: Appliance | null | undefined, kind: ApplianceKind): InfoDisclosure | null {
            const error = this.applianceError(appliance);
            if (error) {
                if (kind === 'dryer' && error.code === 'EMPTY_WATER_ALERT_ERROR') {
                    return {
                        title: '배관 에러',
                        detail: '건조기에 배관 에러가 표시될 경우, 필터 먼지 과다가 원인일 수 있습니다. 필터를 청소해보세요.',
                        code: error.code,
                    };
                }
                return {
                    title: error.label,
                    detail: '기기에 오류가 표시되고 있습니다. 기기 상태를 직접 확인해 주세요.',
                    code: error.code,
                };
            }
            if (appliance?.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION') {
                if (!this.completionConfirmationDelayed(appliance)) return null;
                return {
                    title: '완료 확인 지연',
                    detail: '예상 잔여 시간은 지났지만 LG ThinQ에서 완료 상태가 아직 확인되지 않았습니다. 완료가 확인될 때까지 사용 중으로 표시합니다.',
                };
            }
            const adjustment = this.adjustmentMessage(appliance);
            return adjustment ? {title: '예상 시간 변경', detail: adjustment} : null;
        },

        sourceInfo(this: any, tab: CampusTab): InfoDisclosure {
            const hasError = Boolean(this.errors[tab]);
            if (hasError && this.hasData(tab)) {
                return {
                    title: '업데이트 실패',
                    detail: '새 정보를 확인하지 못해 마지막으로 저장된 정보를 표시하고 있습니다.',
                };
            }
            if (hasError) {
                return {
                    title: '불러오기 실패',
                    detail: '저장된 정보가 없고 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
                };
            }
            return tab === 'laundry'
                ? {
                    title: '갱신 방식',
                    detail: 'LG ThinQ의 상태 반영에는 약 5분이 걸릴 수 있습니다.',
                }
                : {
                    title: '갱신 방식',
                    detail: '점심·저녁 식단이 게시되는 시간대에는 더 자주 확인합니다.',
                };
        },

        parseDate(value?: string) {
            if (!value) return null;
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        },

        relativeTime(this: any, value?: string | Date) {
            return relativeTimeKo(value, this.clockNow);
        },

        formatClock(this: any, value?: string) {
            const parsed = this.parseDate(value);
            return parsed ? new Intl.DateTimeFormat('ko-KR', {timeZone: KST_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false}).format(parsed) : null;
        },

        formatToday(this: any) {
            return new Intl.DateTimeFormat('ko-KR', {timeZone: KST_TIME_ZONE, month: 'long', day: 'numeric', weekday: 'long'}).format(new Date(this.clockNow));
        },

        mealWeekLabel(this: any) {
            return sourceMealWeekLabel(this.currentWeeklyMenu());
        },

        postIsToday(this: any, post: MealPost) {
            const parts = new Intl.DateTimeFormat('en-US', {timeZone: KST_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric'});
            const asObject = (date: Date) => Object.fromEntries(parts.formatToParts(date).map((part) => [part.type, Number(part.value)]));
            const today = asObject(new Date());
            const titleDate = post.title?.match(/(\d{1,2})월\s*(\d{1,2})일/);
            if (titleDate) return Number(titleDate[1]) === today.month && Number(titleDate[2]) === today.day;
            const published = this.parseDate(post.publishedAt);
            if (!published) return false;
            const date = asObject(published);
            return date.year === today.year && date.month === today.month && date.day === today.day;
        },

        dailyMenus(this: any): MealPost[] {
            return [...(this.meals?.data.dailyMenus ?? [])].sort((left, right) => Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? ''));
        },

        todayMeal(this: any, period: 'lunch' | 'dinner') {
            const keyword = period === 'lunch' ? '중식' : '석식';
            return this.dailyMenus().filter((post: MealPost) => this.postIsToday(post)).find((post: MealPost) => post.title?.includes(keyword)) ?? null;
        },

        safeAssetUrl(value?: string) {
            if (!value) return null;
            try {
                const parsed = new URL(value);
                return isSafeImageAssetUrl(parsed.toString()) ? parsed.toString() : null;
            } catch { return null; }
        },

        imageUrl(this: any, post?: MealPost | null) { return this.safeAssetUrl(post?.images?.[0]?.url); },
        postIdentity(post: MealPost, index: number) {
            return post.id
                ? `${post.id}:${post.contentSha ?? post.updatedAt ?? ''}`
                : post.permalink ?? `${post.title ?? 'post'}-${post.publishedAt ?? index}`;
        },
        postKey(this: any, post: MealPost, index: number) { return this.postIdentity(post, index); },

        safeKakaoUrl(value?: string) {
            if (!value) return null;
            try {
                const parsed = new URL(value.replace(/^http:\/\//, 'https://'));
                return parsed.protocol === 'https:' && parsed.hostname === 'pf.kakao.com' ? parsed.toString() : null;
            } catch { return null; }
        },

        async openPost(this: any, post: MealPost) {
            const url = this.safeKakaoUrl(post.permalink);
            if (url) {
                reportCampusInteraction({action: 'meal_post_opened'});
                await openUrl(url).catch((error) => console.error('[campus] external URL failed', error));
            }
        },

        async openImage(this: any, post: MealPost) {
            const url = this.imageUrl(post);
            if (!url) return;
            try {
                await invoke('open_image_viewer', {
                    imageUrl: url,
                });
                reportCampusInteraction({action: 'meal_image_opened'});
            } catch (error) {
                console.error('[campus] image viewer failed', error);
                await message(`이미지 뷰어를 열지 못했습니다.\n\n${String(error)}`, {
                    title: '이미지 뷰어',
                    kind: 'error',
                }).catch((dialogError) => console.error('[campus] image viewer error dialog failed', dialogError));
            }
        },
    };
}

Alpine.data('campus', campus);
Alpine.data('infoDisclosure', infoDisclosure);
Alpine.start();
