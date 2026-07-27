import type {DdayPeriod} from './dday-progress.ts';

export type TrayPanelStatus =
    | 'loading'
    | 'recovering'
    | 'offline'
    | 'needsLogin'
    | 'active'
    | 'complete'
    | 'normal';

export interface TrayPanelState {
    status: TrayPanelStatus;
    statusText: string;
    ddayText: string | null;
    ddayPeriod: DdayPeriod | null;
    currentVersion: string;
    pendingUpdate: string | null;
}

export type NewsItemType = 'announcement' | 'poll' | 'question' | 'discussion';

export interface NewsItem {
    id: string;
    type: NewsItemType;
    title: string;
    body: string;
    url: string;
    category: string;
    pinned?: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface NewsFeed {
    version: number;
    generatedAt: string;
    items: NewsItem[];
}

export type StatusTone = 'neutral' | 'warning' | 'danger' | 'success' | 'accent';

export interface StatusPresentation {
    tone: StatusTone;
    actionLabel: string | null;
}

export interface StatusTextParts {
    title: string;
    detail: string | null;
}

const STATUS_PRESENTATIONS: Record<TrayPanelStatus, StatusPresentation> = {
    loading: {
        tone: 'neutral',
        actionLabel: null,
    },
    recovering: {
        tone: 'neutral',
        actionLabel: null,
    },
    offline: {
        tone: 'neutral',
        actionLabel: '출석 페이지 열기',
    },
    needsLogin: {
        tone: 'warning',
        actionLabel: '로그인하기',
    },
    active: {
        tone: 'danger',
        actionLabel: '출석 페이지 열기',
    },
    complete: {
        tone: 'success',
        actionLabel: null,
    },
    normal: {
        tone: 'accent',
        actionLabel: null,
    },
};

export function statusPresentation(status: TrayPanelStatus): StatusPresentation {
    return STATUS_PRESENTATIONS[status];
}

export function splitStatusText(statusText: string): StatusTextParts {
    const normalized = statusText.trim();
    const match = normalized.match(/^(.+?)\s*\(([^()]*)\)$/);
    if (!match) return {title: normalized, detail: null};

    const title = match[1]?.trim() ?? normalized;
    const detail = match[2]?.trim();
    return {title, detail: detail || null};
}

export function newsItemLabel(item: NewsItem): string {
    if (item.pinned) return '상단 고정';

    switch (item.type) {
        case 'announcement':
            return '공지';
        case 'poll':
            return '설문';
        case 'question':
            return '질문';
        default:
            return '이야기';
    }
}

export function sortNewsItems(items: NewsItem[]): NewsItem[] {
    return [...items].sort((left, right) => {
        const pinnedOrder = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
        if (pinnedOrder !== 0) return pinnedOrder;

        const createdOrder = right.createdAt.localeCompare(left.createdAt);
        if (createdOrder !== 0) return createdOrder;

        return right.id.localeCompare(left.id);
    });
}

export function newsExcerpt(body: string): string {
    return body
        .replace(/!\[[^\]]*]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/[`*_>#~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
}
