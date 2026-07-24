import Alpine from 'alpinejs';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {
    newsExcerpt,
    newsItemLabel,
    newsCount,
    statusPresentation,
    type NewsFeed,
    type NewsItem,
    type StatusPresentation,
    type TrayPanelState,
} from './tray-panel-state.ts';

type PanelTab = 'home' | 'news';
type PanelAction =
    | 'open_attendance'
    | 'open_laundry'
    | 'open_meals'
    | 'open_settings'
    | 'open_discussions'
    | 'check_update'
    | 'quit';

interface TrayPanelComponent {
    activeTab: PanelTab;
    state: TrayPanelState;
    newsFeed: NewsFeed;
    newsLoading: boolean;
    newsError: boolean;
    seenNewsIds: string[];
    busyAction: PanelAction | null;
    get presentation(): StatusPresentation;
    get newsItems(): NewsItem[];
    get newsTotal(): number;
    init(): Promise<void>;
    refresh(): Promise<void>;
    refreshNews(): Promise<void>;
    selectTab(tab: PanelTab): void;
    markNewsSeen(): void;
    openNewsItem(item: NewsItem): Promise<void>;
    newsLabel(item: NewsItem): string;
    newsSummary(item: NewsItem): string;
    newsDate(item: NewsItem): string;
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
const SEEN_NEWS_KEY = 'jungle-bell.seen-news';

function loadSeenNewsIds(): string[] {
    try {
        const value = JSON.parse(localStorage.getItem(SEEN_NEWS_KEY) ?? '[]');
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-100) : [];
    } catch {
        return [];
    }
}

function trayPanel(): TrayPanelComponent {
    return {
        activeTab: 'home',
        state: {...INITIAL_STATE},
        newsFeed: {...INITIAL_NEWS_FEED},
        newsLoading: true,
        newsError: false,
        seenNewsIds: loadSeenNewsIds(),
        busyAction: null,

        get presentation() {
            return statusPresentation(this.state.status);
        },

        get newsTotal() {
            return newsCount(this.state, this.newsItems, this.seenNewsIds);
        },

        get newsItems() {
            return this.newsFeed.items;
        },

        async init() {
            await listen<TrayPanelState>('tray-panel-state', (event) => {
                this.state = event.payload;
            }).catch((error) => console.error('[tray-panel] state listener failed', error));
            window.addEventListener('focus', () => {
                void this.refresh();
                void this.refreshNews();
            });
            await Promise.all([this.refresh(), this.refreshNews()]);
        },

        async refresh() {
            try {
                this.state = await invoke<TrayPanelState>('get_tray_panel_state');
            } catch (error) {
                console.error('[tray-panel] state refresh failed', error);
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

        selectTab(tab) {
            this.activeTab = tab;
            if (tab === 'news') this.markNewsSeen();
        },

        markNewsSeen() {
            const ids = new Set(this.seenNewsIds);
            this.newsItems.forEach((item) => ids.add(item.id));
            if (this.state.pendingUpdate) ids.add(`release-${this.state.pendingUpdate.replace(/^v/, '')}`);
            this.seenNewsIds = [...ids].slice(-100);
            localStorage.setItem(SEEN_NEWS_KEY, JSON.stringify(this.seenNewsIds));
        },

        async openNewsItem(item) {
            this.markNewsSeen();
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

        async perform(action) {
            if (this.busyAction) return;
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
