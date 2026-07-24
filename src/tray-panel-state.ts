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
    currentVersion: string;
    pendingUpdate: string | null;
}

export type NewsItemType = 'announcement' | 'poll' | 'question' | 'discussion' | 'release';

export interface NewsItem {
    id: string;
    type: NewsItemType;
    title: string;
    body: string;
    url: string;
    category: string;
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
    label: string;
    tone: StatusTone;
    actionLabel: string | null;
}

const STATUS_PRESENTATIONS: Record<TrayPanelStatus, StatusPresentation> = {
    loading: {
        label: '상태 확인 중',
        tone: 'neutral',
        actionLabel: null,
    },
    recovering: {
        label: '다시 연결 중',
        tone: 'neutral',
        actionLabel: null,
    },
    offline: {
        label: '상태 확인 불가',
        tone: 'neutral',
        actionLabel: '출석 페이지 열기',
    },
    needsLogin: {
        label: '로그인 필요',
        tone: 'warning',
        actionLabel: '로그인하기',
    },
    active: {
        label: '출석 확인 필요',
        tone: 'danger',
        actionLabel: '출석 페이지 열기',
    },
    complete: {
        label: '오늘 출석 완료',
        tone: 'success',
        actionLabel: null,
    },
    normal: {
        label: '출석 상태 정상',
        tone: 'accent',
        actionLabel: null,
    },
};

export function statusPresentation(status: TrayPanelStatus): StatusPresentation {
    return STATUS_PRESENTATIONS[status];
}

function releaseNewsId(version: string): string {
    return `release-${version.replace(/^v/, '')}`;
}

export function newsCount(
    state: TrayPanelState,
    items: NewsItem[] = [],
    seenIds: string[] = [],
): number {
    const seen = new Set(seenIds);
    const ids = new Set(items.map((item) => item.id));
    if (state.pendingUpdate) ids.add(releaseNewsId(state.pendingUpdate));
    return [...ids].filter((id) => !seen.has(id)).length;
}

export function newsItemLabel(item: NewsItem): string {
    switch (item.type) {
        case 'announcement':
            return '공지';
        case 'poll':
            return '설문';
        case 'question':
            return '질문';
        case 'release':
            return '릴리즈';
        default:
            return '이야기';
    }
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
