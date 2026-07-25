import Alpine from 'alpinejs';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {
    attendanceDashboardSummary,
    dashboardUpdates,
    formatDashboardDate,
    formatDashboardUpdateTime,
    laundryDashboardSummary,
    mealDashboardSummary,
    newsExcerpt,
    newsItemLabel,
    sortNewsItems,
    splitStatusText,
    statusPresentation,
    type CampusDataKind,
    type CampusError,
    type CampusSnapshot,
    type CampusUpdate,
    type DashboardSummary,
    type DashboardUpdate,
    type NewsFeed,
    type NewsItem,
    type StatusPresentation,
    type StatusTextParts,
    type TrayPanelState,
} from './tray-panel-state.ts';

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
    state: TrayPanelState;
    campusSnapshots: Record<CampusDataKind, CampusSnapshot | null>;
    campusErrors: Record<CampusDataKind, boolean>;
    clockNow: number;
    newsFeed: NewsFeed;
    newsLoading: boolean;
    newsError: boolean;
    busyAction: PanelAction | null;
    get presentation(): StatusPresentation;
    get statusTextParts(): StatusTextParts;
    get attendanceSummary(): DashboardSummary;
    get mealsSummary(): DashboardSummary;
    get laundrySummary(): DashboardSummary;
    get recentUpdates(): DashboardUpdate[];
    get dashboardDate(): string;
    get newsItems(): NewsItem[];
    init(): Promise<void>;
    refresh(): Promise<void>;
    refreshCampusState(): Promise<void>;
    refreshNews(): Promise<void>;
    toggleMenu(): void;
    closeMenu(): void;
    selectTab(tab: PanelTab): void;
    openNewsItem(item: NewsItem): Promise<void>;
    newsLabel(item: NewsItem): string;
    newsSummary(item: NewsItem): string;
    newsDate(item: NewsItem): string;
    updateTime(item: DashboardUpdate): string;
    perform(action: PanelAction): Promise<void>;
    hide(): Promise<void>;
}

const INITIAL_STATE: TrayPanelState = {
    status: 'loading',
    statusText: '상태 확인 중...',
    ddayText: 'D-day 확인 중...',
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
        state: {...INITIAL_STATE},
        campusSnapshots: {laundry: null, meals: null},
        campusErrors: {laundry: false, meals: false},
        clockNow: Date.now(),
        newsFeed: {...INITIAL_NEWS_FEED},
        newsLoading: true,
        newsError: false,
        busyAction: null,

        get presentation() {
            return statusPresentation(this.state.status);
        },

        get statusTextParts() {
            return splitStatusText(this.state.statusText);
        },

        get attendanceSummary() {
            return attendanceDashboardSummary(this.state);
        },

        get mealsSummary() {
            return mealDashboardSummary(
                this.campusSnapshots.meals,
                this.campusErrors.meals,
                new Date(this.clockNow),
            );
        },

        get laundrySummary() {
            return laundryDashboardSummary(
                this.campusSnapshots.laundry,
                this.campusErrors.laundry,
            );
        },

        get recentUpdates() {
            return dashboardUpdates(
                this.campusSnapshots.meals,
                this.campusSnapshots.laundry,
                new Date(this.clockNow),
            );
        },

        get dashboardDate() {
            return formatDashboardDate(new Date(this.clockNow));
        },

        get newsItems() {
            return sortNewsItems(this.newsFeed.items);
        },

        async init() {
            await Promise.all([
                listen<TrayPanelState>('tray-panel-state', (event) => {
                    this.state = event.payload;
                }),
                listen<CampusUpdate>('campus-data-updated', (event) => {
                    const {kind, snapshot} = event.payload;
                    if (kind !== 'laundry' && kind !== 'meals') return;
                    this.campusSnapshots[kind] = snapshot;
                    this.campusErrors[kind] = false;
                    this.clockNow = Date.now();
                }),
                listen<CampusError>('campus-data-error', (event) => {
                    const {kind} = event.payload;
                    if (kind !== 'laundry' && kind !== 'meals') return;
                    this.campusErrors[kind] = true;
                }),
            ]).catch((error) => console.error('[tray-panel] state listener failed', error));
            window.addEventListener('blur', () => this.closeMenu());
            window.addEventListener('focus', () => {
                this.clockNow = Date.now();
                void this.refresh();
                void this.refreshCampusState();
                void this.refreshNews();
            });
            await Promise.all([this.refresh(), this.refreshCampusState(), this.refreshNews()]);
        },

        async refresh() {
            try {
                this.state = await invoke<TrayPanelState>('get_tray_panel_state');
            } catch (error) {
                console.error('[tray-panel] state refresh failed', error);
            }
        },

        async refreshCampusState() {
            await invoke('report_campus_ready').catch((error) => {
                console.error('[tray-panel] campus state refresh failed', error);
            });
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
        },

        closeMenu() {
            this.menuOpen = false;
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

        updateTime(item) {
            return formatDashboardUpdateTime(item.occurredAt);
        },

        async perform(action) {
            if (this.busyAction) return;
            this.closeMenu();
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
