import Alpine from 'alpinejs';
import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {openUrl} from '@tauri-apps/plugin-opener';

type CampusTab = 'laundry' | 'meals';
type LaundryFilter = 'all' | 'active' | 'available';
type LaundryAccess = 'all' | 'men' | 'women';
type MachineZone = 'men' | 'common' | 'women' | 'other';
type ApplianceKind = 'washer' | 'dryer';
type Tone = 'neutral' | 'normal' | 'success' | 'warning' | 'danger' | 'complete';

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
    state?: {code?: string; labelKo?: string};
    totalMinutes?: number;
    estimatedFinishAt?: string;
    observedAt?: string;
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
    title?: string;
    text?: string;
    publishedAt?: string;
    permalink?: string;
    images?: Array<{url?: string}>;
}

interface MealsData {
    schemaVersion: number;
    dailyMenus: MealPost[];
    pinnedMenus: MealPost[];
    recentMenus?: MealPost[];
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
    title: string;
    detail: string;
    tone: Tone;
}

interface StatusView {
    label: string;
    tone: Tone;
}

interface ApplianceInfo {
    title: string;
    detail: string;
}

interface TypeSummary {
    total: number;
    available: number;
    active: number;
    issue: number;
    percent: number;
}

const ACTIVE_STATUSES = new Set(['RUNNING', 'PAUSED', 'SCHEDULED']);
const ISSUE_PROJECTIONS = new Set(['AWAITING_COMPLETION_CONFIRMATION', 'ERROR', 'UNKNOWN']);
const KST_TIME_ZONE = 'Asia/Seoul';
const LG_STATE_LABELS: Record<string, string> = {
    POWER_OFF: '전원 꺼짐', INITIAL: '사용 가능', RESERVED: '예약됨', DETECTING: '세탁량 감지 중',
    DISPENSING: '세제 투입 중', SOAKING: '불림 중', WASHING: '세탁 중', RINSING: '헹굼 중',
    SPINNING: '탈수 중', RUNNING: '작동 중', DRYING: '건조 중', COOLING: '식힘 중',
    REFRESHING: '리프레시 중', WRINKLE_CARE: '구김 방지 중', PAUSE: '일시 정지', END: '완료',
    ERROR: '오류', UNKNOWN: '알 수 없음',
};
const PROJECTION_LABELS: Record<string, string> = {
    OBSERVED: '관측값', ESTIMATED_RUNNING: '작동 중', AWAITING_COMPLETION_CONFIRMATION: '완료 확인 중',
    CONFIRMED_COMPLETED: '완료', PAUSED: '일시 정지', ERROR: '오류', IDLE: '사용 가능', UNKNOWN: '확인 불가',
};

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

declare global {
    interface Window {
        setCampusTab?: (tab: string) => void;
    }
}

function initialTab(): CampusTab {
    return new URLSearchParams(window.location.search).get('tab') === 'meals' ? 'meals' : 'laundry';
}

function campus(): Record<string, unknown> {
    return {
        activeTab: initialTab() as CampusTab,
        laundryFilter: 'all' as LaundryFilter,
        laundryAccess: 'all' as LaundryAccess,
        laundry: null as LaundryData | null,
        meals: null as MealsPayload | null,
        refreshing: false,
        infoExpanded: false,
        source: {
            laundry: {title: '세탁기 상태 확인 중', detail: '데이터를 불러오고 있습니다.', tone: 'neutral'},
            meals: {title: '식단 확인 중', detail: '데이터를 불러오고 있습니다.', tone: 'neutral'},
        } as Record<CampusTab, SourceState>,
        errors: {laundry: null, meals: null} as Record<CampusTab, string | null>,
        unlisteners: [] as UnlistenFn[],

        async init(this: any) {
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
                await invoke('report_campus_ready');
            } catch (error) {
                console.error('[campus] Rust state connection failed', error);
                this.applyError({kind: this.activeTab, message: String(error)});
            }
        },

        destroy(this: any) {
            this.unlisteners.forEach((unlisten: UnlistenFn) => unlisten());
            this.unlisteners = [];
            delete window.setCampusTab;
        },

        selectTab(this: any, tab: CampusTab) {
            this.activeTab = tab;
            const url = new URL(window.location.href);
            url.searchParams.set('tab', tab);
            window.history.replaceState(null, '', url);
        },

        applySnapshot(this: any, update: CampusUpdate) {
            const {kind, snapshot} = update;
            if (!snapshot || typeof snapshot.savedAt !== 'number') return;
            if (kind === 'laundry' && this.isLaundryPayload(snapshot.data)) {
                this.laundry = snapshot.data;
                const freshness = this.freshnessView(this.laundry.quality?.sourceFreshness, this.laundry.quality?.sourceFreshnessLabelKo);
                this.source.laundry = {
                    title: freshness.title,
                    detail: `LG ThinQ 확인 ${this.relativeTime(this.laundry.quality?.lastCheckedAt)} · 약 5분 간격`,
                    tone: freshness.tone,
                };
            } else if (kind === 'meals' && this.isMealsPayload(snapshot.data)) {
                this.meals = snapshot.data;
                this.source.meals = {
                    title: '최신 식단 확인됨',
                    detail: `마지막 수집 ${this.relativeTime(this.meals.lastCheckedAt)}`,
                    tone: 'success',
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
            this.source[error.kind] = hasData
                ? {title: '최신 상태 확인 실패', detail: '이전에 받은 정보를 표시합니다.', tone: 'warning'}
                : {title: '데이터를 가져오지 못함', detail: '네트워크 연결 또는 수집 상태를 확인해 주세요.', tone: 'danger'};
        },

        async refresh(this: any) {
            if (this.refreshing) return;
            this.refreshing = true;
            try {
                await invoke('refresh_campus_data', {kind: this.activeTab});
            } catch (error) {
                console.error(`[campus] ${this.activeTab} refresh failed`, error);
                this.applyError({kind: this.activeTab, message: String(error)});
            } finally {
                this.refreshing = false;
            }
        },

        hasData(this: any, tab: CampusTab) {
            return tab === 'laundry' ? Boolean(this.laundry) : Boolean(this.meals);
        },

        isLaundryPayload(data: unknown): data is LaundryData {
            const value = data as Partial<LaundryData> | null;
            return value?.schemaVersion === 1 && Array.isArray(value.machines) && typeof value.quality === 'object';
        },

        isMealsPayload(data: unknown): data is MealsPayload {
            const value = data as Partial<MealsPayload> | null;
            return value?.data?.schemaVersion === 1
                && Array.isArray(value.data.dailyMenus)
                && Array.isArray(value.data.pinnedMenus);
        },

        appliances(this: any, kind?: ApplianceKind): Appliance[] {
            if (!this.laundry) return [];
            if (kind) return this.laundry.machines.map((machine: Machine) => machine[kind]).filter(Boolean) as Appliance[];
            return this.laundry.machines.flatMap((machine: Machine) => [machine.washer, machine.dryer]).filter(Boolean) as Appliance[];
        },

        typeSummary(this: any, kind: ApplianceKind): TypeSummary {
            const appliances = this.appliances(kind);
            const total = appliances.length;
            const available = appliances.filter((item: Appliance) => this.applianceIsAvailable(item)).length;
            return {
                total,
                available,
                active: appliances.filter((item: Appliance) => this.applianceIsActive(item)).length,
                issue: appliances.filter((item: Appliance) => this.applianceNeedsAttention(item)).length,
                percent: total ? Math.round((available / total) * 100) : 0,
            };
        },

        filteredMachines(this: any): Machine[] {
            if (!this.laundry) return [];
            return [...this.laundry.machines]
                .filter((machine) => {
                    const zone = machineZone(machine.id);
                    if (this.laundryAccess === 'men' && zone !== 'men' && zone !== 'common') return false;
                    if (this.laundryAccess === 'women' && zone !== 'women' && zone !== 'common') return false;
                    const appliances = [machine.washer, machine.dryer].filter(Boolean) as Appliance[];
                    if (this.laundryFilter === 'active') return appliances.some((item) => this.applianceIsActive(item));
                    if (this.laundryFilter === 'available') return appliances.some((item) => this.applianceIsAvailable(item));
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
            return this.laundryFilter === 'active'
                ? '현재 작동 중인 기기가 없습니다.'
                : this.laundryFilter === 'available'
                    ? '현재 사용 가능한 기기가 없습니다.'
                    : '표시할 워시타워가 없습니다.';
        },

        laundryInfo(this: any): string | null {
            const appliances = this.appliances();
            if (appliances.some((item: Appliance) => item.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION')) {
                return '0분이어도 LG ThinQ에서 완료 상태가 확인될 때까지 완료 확인 중으로 표시합니다.';
            }
            if (appliances.some((item: Appliance) => item.projection?.estimated)) {
                return '잔여 시간과 종료 시각은 마지막 LG ThinQ 관측값을 기준으로 계산한 추정치입니다.';
            }
            return null;
        },

        applianceIsActive(appliance?: Appliance | null) {
            return Boolean(appliance && (ACTIVE_STATUSES.has(appliance.operationalStatus ?? '')
                || appliance.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION'));
        },

        applianceIsAvailable(appliance?: Appliance | null) { return appliance?.operationalStatus === 'IDLE'; },
        applianceNeedsAttention(appliance?: Appliance | null) {
            return Boolean(appliance && (ISSUE_PROJECTIONS.has(appliance.projection?.status ?? '')
                || appliance.operationalStatus === 'PAUSED'));
        },

        machineName(id: string) {
            const text = String(id ?? '').trim();
            const number = machineNumber(text);
            return number !== null ? `${number}번 워시타워` : text.replaceAll('_', ' ');
        },

        machineZoneLabel(id: string) {
            return ({men: '남성', common: '공용', women: '여성', other: '기타'} as Record<MachineZone, string>)[machineZone(id)];
        },

        machineSummary(this: any, machine: Machine) {
            const appliances = [machine.washer, machine.dryer].filter(Boolean) as Appliance[];
            const active = appliances.filter((item) => this.applianceIsActive(item)).length;
            const available = appliances.filter((item) => this.applianceIsAvailable(item)).length;
            return active ? `${active}대 작동 중` : available ? `${available}대 사용 가능` : '상태 확인 필요';
        },

        projectionView(appliance?: Appliance | null): StatusView {
            if (!appliance) return {label: '정보 없음', tone: 'neutral'};
            const status = appliance.projection?.status;
            const label = appliance.projection?.statusLabelKo ?? PROJECTION_LABELS[status ?? ''];
            if (status === 'AWAITING_COMPLETION_CONFIRMATION') return {label: label ?? '완료 확인 중', tone: 'warning'};
            if (status === 'CONFIRMED_COMPLETED') return {label: label ?? '완료', tone: 'complete'};
            if (status === 'PAUSED') return {label: label ?? '일시 정지', tone: 'warning'};
            if (status === 'ERROR') return {label: label ?? '오류', tone: 'danger'};
            if (status === 'UNKNOWN') return {label: label ?? '확인 불가', tone: 'neutral'};
            if (appliance.operationalStatus === 'SCHEDULED') return {label: appliance.operationalStatusLabelKo ?? '예약됨', tone: 'normal'};
            if (status === 'IDLE') return {label: label ?? '사용 가능', tone: 'success'};
            return {
                label: appliance.state?.labelKo ?? LG_STATE_LABELS[appliance.state?.code ?? '']
                    ?? label ?? appliance.operationalStatusLabelKo ?? '작동 중',
                tone: 'normal',
            };
        },

        remainingText(appliance?: Appliance | null) {
            if (!appliance) return '--';
            const status = appliance.projection?.status;
            if (status === 'CONFIRMED_COMPLETED') return '완료';
            if (status === 'ERROR') return '오류';
            if (status === 'IDLE') return appliance.operationalStatus === 'SCHEDULED' ? '예약' : '대기';
            if (status === 'UNKNOWN') return '--';
            const minutes = appliance.projection?.remainingMinutes;
            if (!Number.isFinite(minutes)) return '--';
            const value = minutes as number;
            if (value >= 60) {
                const hours = Math.floor(value / 60);
                const rest = value % 60;
                return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
            }
            return `${value}분`;
        },

        progress(this: any, appliance?: Appliance | null) {
            const total = appliance?.totalMinutes ?? 0;
            const remaining = appliance?.projection?.remainingMinutes;
            if (!total || !Number.isFinite(remaining) || !this.applianceIsActive(appliance)) return null;
            return Math.min(100, Math.max(0, ((total - (remaining as number)) / total) * 100));
        },

        adjustmentMessage(this: any, appliance?: Appliance | null) {
            if (!appliance || !this.laundry) return null;
            const matching = (this.laundry.events ?? [])
                .filter((event: LaundryEvent) => event.machineId === appliance.machineId && event.appliance === appliance.appliance)
                .sort((left: LaundryEvent, right: LaundryEvent) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
            const priority = ['ERROR_ENTERED', 'ETA_EXTENDED', 'ETA_REDUCED', 'TOTAL_TIME_ADJUSTED', 'ERROR_CLEARED', 'COMPLETED', 'STARTED'];
            const current = priority.map((type) => matching.find((event: LaundryEvent) => event.type === type)).find(Boolean) as LaundryEvent | undefined;
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
            return ({ERROR_ENTERED: '기기 오류가 감지됐습니다.', ERROR_CLEARED: '기기 오류가 해제됐습니다.', COMPLETED: '작동 완료가 확인됐습니다.', STARTED: '작동 시작이 확인됐습니다.'} as Record<string, string>)[current.type] ?? null;
        },

        applianceInfo(this: any, appliance: Appliance | null | undefined, kind: ApplianceKind): ApplianceInfo | null {
            if (kind === 'dryer' && appliance?.errorCode?.trim().toUpperCase() === 'EMPTY_WATER_ALERT_ERROR') {
                return {
                    title: '⚠ 배관 에러 발생 시',
                    detail: '건조기에 배관 에러가 표시될 경우, 필터 먼지 과다가 원인일 수 있습니다. 필터를 청소해보세요.',
                };
            }
            const adjustment = this.adjustmentMessage(appliance);
            return adjustment ? {title: '상태 변경 안내', detail: adjustment} : null;
        },

        freshnessView(freshness?: string, labelKo?: string): SourceState {
            const values: Record<string, [string, Tone]> = {
                REFRESH_OBSERVED: ['원격 상태 갱신됨', 'success'], WITHIN_REFRESH_WINDOW: ['다음 원격 갱신 대기', 'normal'],
                REFRESH_OVERDUE: ['원격 갱신 지연', 'warning'], UNVERIFIABLE_STABLE: ['상태 변화 없음', 'neutral'], COLLECTION_GAP: ['수집 연결 지연', 'danger'],
            };
            const [title, tone] = values[freshness ?? ''] ?? ['갱신 상태 확인 중', 'neutral'];
            return {title: labelKo ?? title, detail: '', tone};
        },

        parseDate(value?: string) {
            if (!value) return null;
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        },

        relativeTime(this: any, value?: string | Date) {
            const parsed = value instanceof Date ? value : this.parseDate(value);
            if (!parsed) return '확인 시각 없음';
            const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
            if (seconds < 30) return '방금';
            if (seconds < 60) return `${seconds}초 전`;
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}분 전`;
            const hours = Math.floor(minutes / 60);
            return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
        },

        formatClock(this: any, value?: string) {
            const parsed = this.parseDate(value);
            return parsed ? new Intl.DateTimeFormat('ko-KR', {timeZone: KST_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false}).format(parsed) : null;
        },

        formatToday() {
            return new Intl.DateTimeFormat('ko-KR', {timeZone: KST_TIME_ZONE, month: 'long', day: 'numeric', weekday: 'long'}).format(new Date());
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

        recentMenus(this: any): MealPost[] {
            const archived = this.meals?.data.recentMenus ?? this.dailyMenus();
            return [...archived].filter((post) => !this.postIsToday(post))
                .sort((left, right) => Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '')).slice(0, 6);
        },

        safeAssetUrl(value?: string) {
            if (!value) return null;
            try {
                const parsed = new URL(value);
                const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
                return ((parsed.protocol === 'https:' || localHttp) && parsed.pathname.startsWith('/v1/assets/')) ? parsed.toString() : null;
            } catch { return null; }
        },

        imageUrl(this: any, post?: MealPost | null) { return this.safeAssetUrl(post?.images?.[0]?.url); },
        postKey(post: MealPost, index: number) { return post.id ?? post.permalink ?? `${post.title ?? 'post'}-${index}`; },

        safeKakaoUrl(value?: string) {
            if (!value) return null;
            try {
                const parsed = new URL(value.replace(/^http:\/\//, 'https://'));
                return parsed.protocol === 'https:' && parsed.hostname === 'pf.kakao.com' ? parsed.toString() : null;
            } catch { return null; }
        },

        async openPost(this: any, post: MealPost) {
            const url = this.safeKakaoUrl(post.permalink);
            if (url) await openUrl(url).catch((error) => console.error('[campus] external URL failed', error));
        },

        openImage(this: any, post: MealPost, dialog: HTMLDialogElement) {
            const url = this.imageUrl(post);
            if (!url) return;
            this.dialogImage = url;
            this.dialogCaption = post.title ?? '식단';
            dialog.showModal();
        },

        dialogImage: '',
        dialogCaption: '',
        closeImage(this: any, dialog: HTMLDialogElement) {
            dialog.close();
            this.dialogImage = '';
        },
    };
}

Alpine.data('campus', campus);
Alpine.start();
