// LMS origin에서 실행되는 hidden checker WebView 스크립트.
// Vite가 dist/injected/checker.js 단일 classic script로 변환한다.

type LogLevel = 'error' | 'warn' | 'debug' | 'info';
type CohortStatus = 'active' | 'unknown' | 'ended' | 'none';

interface TauriEvent<T> {
    payload: T;
}

interface TauriGlobal {
    core: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
    event: {
        listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<() => void>;
    };
}

interface Window {
    __TAURI__: TauriGlobal;
}

interface RawCohort {
    id?: unknown;
    isActive?: unknown;
    startDate?: unknown;
    endDate?: unknown;
}

interface NormalizedCohort {
    id: string;
    is_active: boolean;
    start_date: string;
    end_date: string | null;
}

interface CohortSelection {
    cohort_id: string | null;
    cohort_status: CohortStatus;
    cohort_end_date: string | null;
    fetched_date?: string;
    needs_login?: boolean;
    api_error?: boolean;
}

interface AttendanceValue {
    morning_done: boolean;
    evening_done: boolean;
}

type AttendanceFetchResult = AttendanceValue | {needs_login: true} | null;

interface AttendanceResult {
    needs_login: boolean;
    morning_done: boolean;
    evening_done: boolean;
    api_error?: boolean;
    cohort_status?: CohortStatus;
    cohort_end_date?: string | null;
}

interface TriggerCheckPayload {
    generation?: unknown;
}

let cachedCohortSelection: CohortSelection | null = null;
let identityReported = false;
let checkInFlight = false;
let currentGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function jsLog(level: LogLevel, message: string): void {
    void window.__TAURI__.core.invoke('log_from_js', {level, message});
}

function reportCheckerReady(): void {
    void window.__TAURI__.core.invoke('report_checker_ready', {generation: currentGeneration}).catch((error: unknown) => {
        jsLog('warn', `report_checker_ready failed: ${errorMessage(error)}`);
    });
}

function kstDateStringFromTimestamp(timestamp: number): string {
    return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function currentKstDateString(): string {
    return kstDateStringFromTimestamp(Date.now());
}

function normalizeDateString(value: unknown): string | null {
    if (!value) return null;

    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
    if (match?.[1] && !hasExplicitTimezone) return match[1];

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return kstDateStringFromTimestamp(parsed.getTime());
    return match?.[1] ?? null;
}

function compareCohortDesc(left: NormalizedCohort, right: NormalizedCohort): number {
    if (left.start_date !== right.start_date) return left.start_date < right.start_date ? 1 : -1;
    if ((left.end_date ?? '') !== (right.end_date ?? '')) return (left.end_date ?? '') < (right.end_date ?? '') ? 1 : -1;
    return 0;
}

function parseActiveFlag(value: unknown): boolean {
    return value === true || value === 'true';
}

function parseCohorts(cohorts: RawCohort[], today: string): CohortSelection {
    const normalized = cohorts
        .map((cohort): NormalizedCohort | null => {
            const id = typeof cohort.id === 'string' ? cohort.id : null;
            const startDate = normalizeDateString(cohort.startDate);
            if (!id || !startDate) return null;
            return {
                id,
                is_active: parseActiveFlag(cohort.isActive),
                start_date: startDate,
                end_date: normalizeDateString(cohort.endDate),
            };
        })
        .filter((cohort): cohort is NormalizedCohort => cohort !== null);

    if (normalized.length === 0) {
        return {cohort_id: null, cohort_status: 'none', cohort_end_date: null};
    }

    const fallback = normalized.slice().sort(compareCohortDesc)[0];
    const dated = normalized.filter((cohort) => cohort.end_date !== null);
    const active = dated
        .filter((cohort) => cohort.is_active && cohort.start_date <= today && today <= (cohort.end_date ?? ''))
        .sort(compareCohortDesc)[0];

    if (active) {
        return {cohort_id: active.id, cohort_status: 'active', cohort_end_date: active.end_date};
    }

    const inRange = dated
        .filter((cohort) => cohort.start_date <= today && today <= (cohort.end_date ?? ''))
        .sort(compareCohortDesc)[0];

    if (inRange) {
        return {cohort_id: inRange.id, cohort_status: 'unknown', cohort_end_date: null};
    }

    if (fallback && !fallback.end_date) {
        return {cohort_id: fallback.id, cohort_status: 'unknown', cohort_end_date: null};
    }

    const ended = dated
        .filter((cohort) => (cohort.end_date ?? '') < today)
        .sort((left, right) => {
            if (left.end_date !== right.end_date) return (left.end_date ?? '') < (right.end_date ?? '') ? 1 : -1;
            return compareCohortDesc(left, right);
        })[0];

    if (ended) {
        return {cohort_id: null, cohort_status: 'ended', cohort_end_date: ended.end_date};
    }

    return {
        cohort_id: fallback?.id ?? null,
        cohort_status: fallback ? 'unknown' : 'none',
        cohort_end_date: null,
    };
}

function parseAttendanceToday(data: unknown): AttendanceValue {
    return {
        morning_done: Boolean(isRecord(data) && data.checkedAt),
        evening_done: Boolean(isRecord(data) && data.checkedOutAt),
    };
}

async function reportIdentityOnce(): Promise<void> {
    if (identityReported) return;

    try {
        const enabled = await window.__TAURI__.core.invoke<boolean>('get_usage_analytics_enabled');
        if (!enabled || identityReported) return;
        identityReported = true;

        const response = await fetch('https://jungle-lms.krafton.com/api/v2/me', {
            credentials: 'include',
            headers: {accept: 'application/json'},
        });
        if (!response.ok) return;

        const data: unknown = await response.json();
        if (isRecord(data) && typeof data.id === 'string') {
            jsLog('debug', 'reportIdentity: id reported');
            await window.__TAURI__.core.invoke('report_cms_identity', {cmsUserId: data.id});
        }
    } catch (error: unknown) {
        jsLog('debug', `reportIdentity failed: ${errorMessage(error)}`);
        identityReported = false;
    }
}

async function fetchCohortSelection(): Promise<CohortSelection> {
    const url = 'https://jungle-lms.krafton.com/api/v2/me/cohorts';
    jsLog('debug', `fetchCohortSelection: GET ${url}`);

    try {
        const response = await fetch(url, {
            credentials: 'include',
            headers: {accept: 'application/json'},
        });
        jsLog('debug', `fetchCohortSelection: response status=${response.status} statusText=${response.statusText}`);

        if (response.status === 401) {
            jsLog('info', 'fetchCohortSelection: status=401 (login required)');
            return {needs_login: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null};
        }
        if (!response.ok) {
            const body = await response.text();
            jsLog('warn', `fetchCohortSelection: status=${response.status}`);
            jsLog('debug', `fetchCohortSelection: error body length=${body.length}`);
            return {api_error: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null};
        }

        const data: unknown = await response.json();
        const cohorts = Array.isArray(data) ? data.filter(isRecord) : [];
        jsLog('debug', `fetchCohortSelection: cohorts count=${cohorts.length}`);
        const today = currentKstDateString();
        const selection = parseCohorts(cohorts, today);
        selection.fetched_date = today;
        jsLog(
            'debug',
            `fetchCohortSelection: selected cohort status=${selection.cohort_status} endDate=${selection.cohort_end_date} (total=${cohorts.length})`,
        );
        return selection;
    } catch (error: unknown) {
        jsLog('error', `fetchCohortSelection failed: ${errorMessage(error)}`);
        return {api_error: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null};
    }
}

async function fetchAttendance(cohortId: string): Promise<AttendanceFetchResult> {
    const url = `https://jungle-lms.krafton.com/api/v2/me/cohorts/${encodeURIComponent(cohortId)}/attendance/today`;
    jsLog('debug', 'fetchAttendance: GET attendance today');

    try {
        const response = await fetch(url, {
            credentials: 'include',
            headers: {accept: 'application/json'},
        });
        jsLog('debug', `fetchAttendance: response status=${response.status} statusText=${response.statusText}`);

        if (response.status === 401) {
            jsLog('info', 'fetchAttendance: status=401 (login required)');
            return {needs_login: true};
        }
        if (!response.ok) {
            const body = await response.text();
            jsLog('warn', `fetchAttendance: status=${response.status}`);
            jsLog('debug', `fetchAttendance: error body length=${body.length}`);
            return null;
        }

        const body = await response.text();
        if (!body.trim()) {
            jsLog('debug', 'fetchAttendance: empty body (no attendance today)');
            return parseAttendanceToday({checkedAt: null, checkedOutAt: null});
        }

        jsLog('debug', 'fetchAttendance: response body received');
        return parseAttendanceToday(JSON.parse(body) as unknown);
    } catch (error: unknown) {
        jsLog('error', `fetchAttendance failed: ${errorMessage(error)}`);
        return null;
    }
}

async function checkAttendance(): Promise<AttendanceResult> {
    if (window.location.href.includes('/login')) {
        jsLog('info', 'login required (/login URL detected)');
        return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_end_date: null,
        };
    }

    const today = currentKstDateString();
    const selection = cachedCohortSelection?.fetched_date === today
        ? cachedCohortSelection
        : await fetchCohortSelection();

    if (selection.api_error) {
        return {needs_login: false, morning_done: false, evening_done: false, api_error: true};
    }
    if (selection.needs_login) {
        cachedCohortSelection = null;
        return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_end_date: null,
        };
    }

    cachedCohortSelection = selection;
    if (!selection.cohort_id) {
        return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            cohort_status: selection.cohort_status,
            cohort_end_date: selection.cohort_end_date,
        };
    }

    void reportIdentityOnce();
    const attendance = await fetchAttendance(selection.cohort_id);
    if (!attendance) {
        jsLog('debug', 'checkAttendance: fetchAttendance returned null -> api_error');
        return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
            cohort_status: selection.cohort_status,
            cohort_end_date: selection.cohort_end_date,
        };
    }
    if ('needs_login' in attendance) {
        jsLog('debug', 'checkAttendance: needs_login flag set, clearing cohort cache');
        cachedCohortSelection = null;
        return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_end_date: null,
        };
    }

    jsLog('debug', `checkAttendance: morning_done=${attendance.morning_done} evening_done=${attendance.evening_done}`);
    return {
        needs_login: false,
        morning_done: attendance.morning_done,
        evening_done: attendance.evening_done,
        cohort_status: selection.cohort_status,
        cohort_end_date: selection.cohort_end_date,
    };
}

function reportResult(result: AttendanceResult): void {
    const status = {...result, generation: currentGeneration};
    jsLog(
        'debug',
        `result: needs_login=${status.needs_login} generation=${status.generation} morning=${status.morning_done} evening=${status.evening_done} cohort_status=${status.cohort_status} cohort_end_date=${status.cohort_end_date}${status.api_error ? ' api_error=true' : ''}`,
    );
    void window.__TAURI__.core.invoke('report_attendance_status', {status});
}

function runCheck(reason: string): void {
    if (checkInFlight) {
        jsLog('debug', `check skipped, already running: ${reason}`);
        return;
    }

    checkInFlight = true;
    jsLog('debug', `check started: ${reason}`);
    void checkAttendance().then(reportResult).finally(() => {
        checkInFlight = false;
    });
}

void window.__TAURI__.event.listen<TriggerCheckPayload>('trigger-check', (event) => {
    if (typeof event.payload?.generation === 'number') currentGeneration = event.payload.generation;
    runCheck('rust-trigger');
}).catch((error: unknown) => {
    jsLog('error', `trigger-check listener failed: ${errorMessage(error)}`);
});

reportCheckerReady();
jsLog('info', 'checker loaded, running initial check');
runCheck('initial-load');
