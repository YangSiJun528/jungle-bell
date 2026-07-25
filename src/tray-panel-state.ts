import {laundryAvailabilityState, type LaundryStatusAppliance} from './laundry-status.ts';

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

export type CampusDataKind = 'laundry' | 'meals';

export interface CampusSnapshot {
    savedAt: number;
    data: unknown;
}

export interface CampusUpdate {
    kind: CampusDataKind;
    snapshot: CampusSnapshot;
}

export interface CampusError {
    kind: CampusDataKind;
    message: string;
}

export interface DashboardSummary {
    detail: string;
    badge: string;
    tone: StatusTone;
}

export interface DashboardUpdate {
    id: string;
    kind: 'meal' | 'laundry';
    title: string;
    occurredAt: string;
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

interface MealPost {
    contentSha?: string;
    title?: string;
    publishedAt?: string;
}

interface LaundryAppliance extends LaundryStatusAppliance {
    machineId?: string;
}

interface LaundryMachine {
    id?: string;
    washer?: LaundryAppliance | null;
    dryer?: LaundryAppliance | null;
}

interface LaundryEvent {
    machineId?: string;
    appliance?: string;
    sessionId?: string | null;
    observedAt?: string;
    type?: string;
    etaDeltaMinutes?: number;
}

const KST_TIME_ZONE = 'Asia/Seoul';

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function dateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: KST_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function todayParts(now: Date): {month: number; day: number} {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: KST_TIME_ZONE,
        month: 'numeric',
        day: 'numeric',
    }).formatToParts(now);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {month: value('month'), day: value('day')};
}

function mealPosts(snapshot: CampusSnapshot | null): MealPost[] {
    if (!isRecord(snapshot?.data) || !isRecord(snapshot.data.data)) return [];
    const posts = snapshot.data.data.dailyMenus;
    if (!Array.isArray(posts)) return [];
    return posts.filter(isRecord) as MealPost[];
}

function mealPostIsToday(post: MealPost, now: Date): boolean {
    const {month, day} = todayParts(now);
    const titleDate = post.title?.match(/(\d{1,2})월\s*(\d{1,2})일/);
    if (titleDate) return Number(titleDate[1]) === month && Number(titleDate[2]) === day;

    const publishedAt = Date.parse(post.publishedAt ?? '');
    return Number.isFinite(publishedAt) && dateKey(new Date(publishedAt)) === dateKey(now);
}

function mealPeriod(post: MealPost): 'lunch' | 'dinner' | null {
    if (post.title?.includes('중식')) return 'lunch';
    if (post.title?.includes('석식')) return 'dinner';
    return null;
}

function isSunday(now: Date): boolean {
    return new Date(`${dateKey(now)}T00:00:00Z`).getUTCDay() === 0;
}

function laundryData(snapshot: CampusSnapshot | null): {machines: LaundryMachine[]; events: LaundryEvent[]} | null {
    if (!isRecord(snapshot?.data) || snapshot.data.schemaVersion !== 1 || !Array.isArray(snapshot.data.machines)) {
        return null;
    }
    return {
        machines: snapshot.data.machines.filter(isRecord) as LaundryMachine[],
        events: Array.isArray(snapshot.data.events)
            ? snapshot.data.events.filter(isRecord) as LaundryEvent[]
            : [],
    };
}

export function attendanceDashboardSummary(state: TrayPanelState): DashboardSummary {
    const detail = state.statusText.replace(/^⚠️\s*/, '');
    switch (state.status) {
        case 'active':
            return {detail, badge: '확인 필요', tone: 'danger'};
        case 'needsLogin':
            return {detail, badge: '로그인', tone: 'warning'};
        case 'complete':
            return {detail, badge: '완료', tone: 'success'};
        case 'normal':
            return {detail, badge: detail.includes('학습 중') ? '진행 중' : '대기', tone: 'accent'};
        case 'offline':
            return {detail, badge: '확인 불가', tone: 'neutral'};
        case 'recovering':
            return {detail, badge: '재확인', tone: 'neutral'};
        default:
            return {detail, badge: '확인 중', tone: 'neutral'};
    }
}

export function mealDashboardSummary(
    snapshot: CampusSnapshot | null,
    hasError: boolean,
    now = new Date(),
): DashboardSummary {
    if (!snapshot) {
        return hasError
            ? {detail: '식단 정보를 불러오지 못했어요', badge: '오류', tone: 'warning'}
            : {detail: '오늘 식단을 확인하고 있어요', badge: '확인 중', tone: 'neutral'};
    }

    const periods = new Set(
        mealPosts(snapshot)
            .filter((post) => mealPostIsToday(post, now))
            .map(mealPeriod)
            .filter((period): period is 'lunch' | 'dinner' => period !== null),
    );
    const lunch = periods.has('lunch');
    const dinner = periods.has('dinner');
    const count = Number(lunch) + Number(dinner);

    if (lunch && dinner) {
        return {detail: '중식·석식 등록', badge: '2개 등록', tone: 'success'};
    }
    if (lunch) {
        return {detail: '중식 등록 · 석식 대기', badge: '1개 등록', tone: 'accent'};
    }
    if (dinner) {
        return {detail: '중식 대기 · 석식 등록', badge: '1개 등록', tone: 'accent'};
    }
    if (isSunday(now)) {
        return {detail: '오늘은 식단이 없는 날이에요', badge: '휴무', tone: 'neutral'};
    }
    return {detail: '중식·석식 게시 대기', badge: count ? `${count}개 등록` : '대기', tone: 'neutral'};
}

export function laundryDashboardSummary(
    snapshot: CampusSnapshot | null,
    hasError: boolean,
): DashboardSummary {
    const data = laundryData(snapshot);
    if (!data) {
        return hasError
            ? {detail: '워시타워 정보를 불러오지 못했어요', badge: '오류', tone: 'warning'}
            : {detail: '사용 가능한 기기를 확인하고 있어요', badge: '확인 중', tone: 'neutral'};
    }

    const appliances = data.machines.flatMap((machine) => [
        {kind: 'washer' as const, appliance: machine.washer},
        {kind: 'dryer' as const, appliance: machine.dryer},
    ]);
    const available = (kind: 'washer' | 'dryer') => appliances
        .filter((entry) => entry.kind === kind)
        .filter((entry) => laundryAvailabilityState(entry.appliance) === 'available')
        .length;
    const washerCount = available('washer');
    const dryerCount = available('dryer');
    const availableCount = washerCount + dryerCount;
    const errorCount = appliances
        .filter((entry) => laundryAvailabilityState(entry.appliance) === 'error')
        .length;

    if (availableCount > 0) {
        return {
            detail: `세탁기 ${washerCount}대 · 건조기 ${dryerCount}대 사용 가능`,
            badge: `${availableCount}대 가능`,
            tone: 'success',
        };
    }
    if (errorCount > 0) {
        return {
            detail: '현재 사용 가능한 기기가 없어요',
            badge: `${errorCount}대 오류`,
            tone: 'warning',
        };
    }
    return {detail: '현재 모든 기기가 사용 중이에요', badge: '사용 중', tone: 'neutral'};
}

function machineNumber(machineId?: string): string {
    return machineId?.match(/(\d+)$/)?.[1] ?? machineId ?? '기기';
}

function laundryUpdateTitle(event: LaundryEvent): string | null {
    const appliance = event.appliance === 'washer' ? '세탁' : event.appliance === 'dryer' ? '건조' : '기기';
    const prefix = `${machineNumber(event.machineId)}번 ${appliance}`;
    switch (event.type) {
        case 'COMPLETED':
            return `${prefix}가 끝났어요`;
        case 'STARTED':
            return `${prefix}가 시작됐어요`;
        case 'ERROR_ENTERED':
            return `${prefix}에 오류가 발생했어요`;
        case 'PAUSED':
            return `${prefix}가 일시 정지됐어요`;
        case 'ETA_EXTENDED':
            return `${prefix} 종료가 ${Math.abs(Math.round(event.etaDeltaMinutes ?? 0))}분 늦어졌어요`;
        case 'ETA_REDUCED':
            return `${prefix} 종료가 ${Math.abs(Math.round(event.etaDeltaMinutes ?? 0))}분 빨라졌어요`;
        default:
            return null;
    }
}

export function dashboardUpdates(
    mealsSnapshot: CampusSnapshot | null,
    laundrySnapshot: CampusSnapshot | null,
    now = new Date(),
): DashboardUpdate[] {
    const mealUpdates = mealPosts(mealsSnapshot)
        .filter((post) => mealPostIsToday(post, now))
        .flatMap((post): DashboardUpdate[] => {
            const period = mealPeriod(post);
            const occurredAt = post.publishedAt;
            if (!period || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return [];
            return [{
                id: `meal:${post.contentSha ?? `${period}:${occurredAt}`}`,
                kind: 'meal',
                title: `오늘 ${period === 'lunch' ? '중식' : '석식'} 식단이 등록됐어요`,
                occurredAt,
            }];
        });

    const laundryUpdates = (laundryData(laundrySnapshot)?.events ?? [])
        .flatMap((event): DashboardUpdate[] => {
            const title = laundryUpdateTitle(event);
            const occurredAt = event.observedAt;
            if (!title || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return [];
            const age = now.getTime() - Date.parse(occurredAt);
            if (age < -5 * 60_000 || age > 24 * 60 * 60_000) return [];
            return [{
                id: `laundry:${event.machineId ?? 'unknown'}:${event.appliance ?? 'unknown'}:${event.sessionId ?? 'none'}:${event.type ?? 'unknown'}:${occurredAt}`,
                kind: 'laundry',
                title,
                occurredAt,
            }];
        });

    return [...mealUpdates, ...laundryUpdates]
        .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
        .slice(0, 3);
}

export function formatDashboardDate(now = new Date()): string {
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: KST_TIME_ZONE,
        month: 'long',
        day: 'numeric',
        weekday: 'long',
    }).format(now);
}

export function formatDashboardUpdateTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: KST_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
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
