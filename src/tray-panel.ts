import Alpine from 'alpinejs';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {
    buildDdayProgress,
    kstDateString,
    type DdayProgress,
} from './dday-progress.ts';
import {
    newsExcerpt,
    newsItemLabel,
    sortNewsItems,
    splitStatusText,
    statusPresentation,
    type NewsFeed,
    type NewsItem,
    type StatusPresentation,
    type StatusTextParts,
    type TrayPanelState,
} from './tray-panel-state.ts';
import {
    EMPTY_LOCAL_DASHBOARD,
    laundryDashboardExpectedEnd,
    laundryDashboardHasSourceWarning,
    laundryDashboardProgress,
    laundryDashboardRemaining,
    type LocalDashboardSnapshot,
} from './local-dashboard.ts';
import {
    resolveHomeTasks,
    type HomeTaskVisibility,
} from './home-tasks.ts';

type PanelTab = 'home' | 'news';
type PanelAction =
    | 'open_attendance'
    | 'open_laundry'
    | 'open_meals'
    | 'open_settings'
    | 'open_feedback'
    | 'check_update'
    | 'quit';

interface TrayPanelComponent {
    activeTab: PanelTab;
    menuOpen: boolean;
    ddayExpanded: boolean;
    state: TrayPanelState;
    dashboard: LocalDashboardSnapshot;
    taskError: string | null;
    clockNow: number;
    clockTimer: number | null;
    ddayToday: string;
    newsFeed: NewsFeed;
    newsLoading: boolean;
    newsError: boolean;
    busyAction: PanelAction | null;
    taskBusy: 'laundry' | null;
    mealAlertBusy: string | null;
    get presentation(): StatusPresentation;
    get statusTextParts(): StatusTextParts;
    get homeTasks(): HomeTaskVisibility;
    get ddayProgress(): DdayProgress | null;
    get newsItems(): NewsItem[];
    init(): Promise<void>;
    destroy(): void;
    refresh(): Promise<void>;
    refreshDashboard(): Promise<void>;
    refreshNews(): Promise<void>;
    toggleMenu(): void;
    closeMenu(restoreFocus?: boolean): void;
    handleMenuKey(event: KeyboardEvent): void;
    selectTab(tab: PanelTab): void;
    openNewsItem(item: NewsItem): Promise<void>;
    newsLabel(item: NewsItem): string;
    newsSummary(item: NewsItem): string;
    newsDate(item: NewsItem): string;
    toggleDday(): void;
    ddayRange(): string;
    ddayProgressLabel(): string;
    laundryRemaining(): string;
    laundryExpectedEnd(): string;
    laundryProgress(): number | null;
    laundryProgressText(): string;
    laundrySourceWarning(): boolean;
    stopLaundryTracking(): Promise<void>;
    dismissMealAlert(alertId: string): Promise<void>;
    perform(action: PanelAction): Promise<void>;
    hide(): Promise<void>;
}

const INITIAL_STATE: TrayPanelState = {
    status: 'loading',
    statusText: '상태 확인 중...',
    ddayText: 'D-day 확인 중...',
    ddayPeriod: null,
    currentVersion: '',
    pendingUpdate: null,
};

const INITIAL_NEWS_FEED: NewsFeed = {
    version: 1,
    generatedAt: '',
    items: [],
};

function trayPanel(): TrayPanelComponent {
    return {
        activeTab: 'home',
        menuOpen: false,
        ddayExpanded: false,
        state: {...INITIAL_STATE},
        dashboard: {...EMPTY_LOCAL_DASHBOARD, mealAlerts: []},
        taskError: null,
        clockNow: Date.now(),
        clockTimer: null,
        ddayToday: kstDateString(),
        newsFeed: {...INITIAL_NEWS_FEED},
        newsLoading: true,
        newsError: false,
        busyAction: null,
        taskBusy: null,
        mealAlertBusy: null,

        get presentation() {
            return statusPresentation(this.state.status);
        },

        get statusTextParts() {
            return splitStatusText(this.state.statusText);
        },

        get homeTasks() {
            return resolveHomeTasks(this.dashboard);
        },

        get ddayProgress() {
            if (!this.state.ddayPeriod) return null;
            return buildDdayProgress(this.state.ddayPeriod, this.ddayToday);
        },

        get newsItems() {
            return sortNewsItems(this.newsFeed.items);
        },

        async init() {
            await listen<TrayPanelState>('tray-panel-state', (event) => {
                this.state = event.payload;
            }).catch((error) => console.error('[tray-panel] state listener failed', error));
            await listen<LocalDashboardSnapshot>('local-dashboard-updated', (event) => {
                this.dashboard = event.payload;
            }).catch((error) => console.error('[tray-panel] dashboard listener failed', error));
            this.clockTimer = window.setInterval(() => {
                this.clockNow = Date.now();
                const today = kstDateString(this.clockNow);
                if (today !== this.ddayToday) this.ddayToday = today;
            }, 1000);
            window.addEventListener('blur', () => this.closeMenu());
            window.addEventListener('focus', () => {
                void this.refresh();
                void this.refreshDashboard();
                void this.refreshNews();
            });
            await Promise.all([
                this.refresh(),
                this.refreshDashboard(),
                this.refreshNews(),
            ]);
        },

        destroy() {
            if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
            this.clockTimer = null;
        },

        async refresh() {
            try {
                this.state = await invoke<TrayPanelState>('get_tray_panel_state');
            } catch (error) {
                console.error('[tray-panel] state refresh failed', error);
            }
        },

        async refreshDashboard() {
            try {
                this.dashboard = await invoke<LocalDashboardSnapshot>('get_local_dashboard_snapshot');
            } catch (error) {
                console.error('[tray-panel] dashboard refresh failed', error);
            }
        },

        async refreshNews() {
            this.newsLoading = this.newsItems.length === 0;
            try {
                this.newsFeed = await invoke<NewsFeed>('get_news_feed');
                this.newsError = false;
            } catch (error) {
                this.newsError = true;
                console.error('[tray-panel] news refresh failed', error);
            } finally {
                this.newsLoading = false;
            }
        },

        toggleMenu() {
            this.menuOpen = !this.menuOpen;
            if (this.menuOpen) {
                void Alpine.nextTick(() => {
                    document
                        .querySelector<HTMLButtonElement>('#app-menu [role="menuitem"]:not(:disabled)')
                        ?.focus();
                });
            }
        },

        closeMenu(restoreFocus = false) {
            this.menuOpen = false;
            if (restoreFocus) {
                void Alpine.nextTick(() => {
                    const menuTrigger = document.querySelector<HTMLButtonElement>('[data-ui="menu-trigger"]');
                    menuTrigger?.focus();
                });
            }
        },

        handleMenuKey(event) {
            const items = Array.from(
                document.querySelectorAll<HTMLButtonElement>('#app-menu [role="menuitem"]:not(:disabled)'),
            );
            if (items.length === 0) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.closeMenu(true);
                return;
            }

            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            let nextIndex: number | null = null;
            if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
            if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = items.length - 1;
            if (nextIndex === null) return;

            event.preventDefault();
            items[nextIndex]?.focus();
        },

        selectTab(tab) {
            this.closeMenu();
            this.activeTab = tab;
        },

        async openNewsItem(item) {
            try {
                await invoke('open_news_item', {url: item.url});
            } catch (error) {
                console.error('[tray-panel] news item open failed', error);
            }
        },

        newsLabel(item) {
            return newsItemLabel(item);
        },

        newsSummary(item) {
            return newsExcerpt(item.body);
        },

        newsDate(item) {
            const date = new Date(item.createdAt);
            if (Number.isNaN(date.getTime())) return '';
            return new Intl.DateTimeFormat('ko-KR', {
                month: 'short',
                day: 'numeric',
            }).format(date);
        },

        toggleDday() {
            if (!this.ddayProgress) return;
            this.ddayExpanded = !this.ddayExpanded;
        },

        ddayRange() {
            const period = this.state.ddayPeriod;
            if (!period) return '';
            const compact = (value: string) => value
                .split('-')
                .map(Number)
                .join('.');
            return `${compact(period.startDate)} – ${compact(period.endDate)}`;
        },

        ddayProgressLabel() {
            const progress = this.ddayProgress;
            if (!progress) return '';
            const current = progress.current ? ', 오늘 진행 중' : '';
            return `코스 진행률 ${progress.percent}%, 완료 ${progress.elapsed}일${current}, 남음 ${progress.remaining}일`;
        },

        laundryRemaining() {
            return this.dashboard.laundry
                ? laundryDashboardRemaining(this.dashboard.laundry, this.clockNow)
                : '';
        },

        laundryExpectedEnd() {
            return this.dashboard.laundry
                ? laundryDashboardExpectedEnd(this.dashboard.laundry)
                : '';
        },

        laundryProgress() {
            return this.dashboard.laundry
                ? laundryDashboardProgress(this.dashboard.laundry, this.clockNow)
                : null;
        },

        laundryProgressText() {
            const progress = this.laundryProgress();
            return progress === null ? '' : `세탁 진행률 ${progress}%`;
        },

        laundrySourceWarning() {
            return this.dashboard.laundry
                ? laundryDashboardHasSourceWarning(this.dashboard.laundry, this.clockNow)
                : false;
        },

        async stopLaundryTracking() {
            if (this.busyAction || this.taskBusy || this.mealAlertBusy) return;
            this.taskBusy = 'laundry';
            this.taskError = null;
            try {
                await invoke('set_laundry_watch', {watch: null});
            } catch (error) {
                this.taskError = '세탁 추적을 종료하지 못했어요. 잠시 후 다시 시도해 주세요.';
                console.error('[tray-panel] set_laundry_watch failed', error);
            } finally {
                this.taskBusy = null;
            }
        },

        async dismissMealAlert(alertId) {
            if (this.busyAction || this.taskBusy || this.mealAlertBusy) return;
            const previousDashboard = this.dashboard;
            this.mealAlertBusy = alertId;
            this.taskError = null;
            this.dashboard = {
                ...this.dashboard,
                mealAlerts: this.dashboard.mealAlerts.filter((alert) => alert.id !== alertId),
            };
            try {
                this.dashboard = await invoke<LocalDashboardSnapshot>(
                    'dismiss_meal_alert',
                    {alertId},
                );
            } catch (error) {
                this.dashboard = previousDashboard;
                this.taskError = '급식 알림을 제거하지 못했어요. 잠시 후 다시 시도해 주세요.';
                console.error('[tray-panel] dismiss_meal_alert failed', error);
            } finally {
                this.mealAlertBusy = null;
            }
        },

        async perform(action) {
            if (this.busyAction || this.taskBusy || this.mealAlertBusy) return;
            this.closeMenu(true);
            this.busyAction = action;
            try {
                await invoke('run_tray_panel_action', {action});
            } catch (error) {
                console.error(`[tray-panel] ${action} failed`, error);
            } finally {
                this.busyAction = null;
            }
        },

        async hide() {
            await invoke('hide_tray_panel').catch((error) => {
                console.error('[tray-panel] hide failed', error);
            });
        },
    };
}

Alpine.data('trayPanel', trayPanel);
Alpine.start();
