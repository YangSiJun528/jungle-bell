// LMS origin에서 실행되는 hidden checker WebView 스크립트.
// desktop 빌드가 dist/desktop/injected/checker.js 단일 classic script로 변환한다.

type LogLevel = 'error' | 'warn' | 'debug' | 'info';
type CohortStatus = 'active' | 'upcoming' | 'unknown' | 'ended' | 'none';

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
    name?: unknown;
    title?: unknown;
    cohortName?: unknown;
    generation?: unknown;
    number?: unknown;
    cohortNumber?: unknown;
    ordinal?: unknown;
}

interface CohortOption {
    id: string;
    label: string;
    startDate: string;
    endDate: string | null;
    isActive: boolean;
}

interface CohortSelection {
    cohort_id: string | null;
    cohort_status: CohortStatus;
    cohort_start_date: string | null;
    cohort_end_date: string | null;
    fetched_date?: string;
    needs_login?: boolean;
    api_error?: boolean;
}

type CheckerEvent =
    | {type: 'ready'; generation: number}
    | {type: 'log'; level: LogLevel; message: string}
    | {type: 'resolveCohort'; cohortOptions: CohortOption[]}
    | {type: 'attendanceSnapshot'; status: AttendanceSnapshot};

interface AttendanceSnapshot {
    generation: number;
    needs_login: boolean;
    morning_done: boolean;
    evening_done: boolean;
    api_error: boolean;
    cohort_status: CohortStatus;
    cohort_start_date: string | null;
    cohort_end_date: string | null;
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
    cohort_start_date?: string | null;
    cohort_end_date?: string | null;
}

interface TriggerCheckPayload {
    generation?: unknown;
}

let cachedCohortOptions: CohortOption[] | null = null;
let cachedCohortDate: string | null = null;
let checkInFlight = false;
let queuedCheckGeneration: number | null = null;
let currentGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
        actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportCheckerEvent(event: CheckerEvent): Promise<unknown> {
    return window.__TAURI__.core.invoke('report_checker_event', {event});
}

function expectAcknowledged(value: unknown): void {
    if (!isRecord(value) || !hasExactKeys(value, ['type']) || value.type !== 'acknowledged') {
        throw new Error('INVALID_CHECKER_ACKNOWLEDGEMENT');
    }
}

function jsLog(level: LogLevel, message: string): void {
    const normalized =
        message
            .replace(/[\u0000-\u001f\u007f]/gu, ' ')
            .trim()
            .slice(0, 512) || 'checker log';
    void reportCheckerEvent({type: 'log', level, message: normalized})
        .then(expectAcknowledged)
        .catch(() => undefined);
}

function reportCheckerReady(): void {
    void reportCheckerEvent({type: 'ready', generation: currentGeneration})
        .then(expectAcknowledged)
        .catch((error: unknown) => {
            jsLog('warn', `report checker ready failed: ${errorMessage(error)}`);
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

function parseActiveFlag(value: unknown): boolean {
    return value === true || value === 'true';
}

function cohortLabel(cohort: RawCohort, startDate: string, endDate: string | null): string {
    for (const value of [cohort.name, cohort.title, cohort.cohortName]) {
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
    }
    for (const value of [cohort.generation, cohort.cohortNumber, cohort.number, cohort.ordinal]) {
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
            const text = String(value).trim();
            return (text.endsWith('기') ? text : `${text}기`).slice(0, 80);
        }
    }
    return `${startDate} ~ ${endDate ?? '종료일 미정'}`;
}

function normalizeCohortOptions(cohorts: RawCohort[]): CohortOption[] {
    return cohorts
        .map((cohort): CohortOption | null => {
            const id = typeof cohort.id === 'string' ? cohort.id : null;
            const startDate = normalizeDateString(cohort.startDate);
            if (!id || !startDate) return null;
            const endDate = normalizeDateString(cohort.endDate);
            return {
                id,
                label: cohortLabel(cohort, startDate, endDate),
                isActive: parseActiveFlag(cohort.isActive),
                startDate,
                endDate,
            };
        })
        .filter((cohort): cohort is CohortOption => cohort !== null);
}

async function resolveCohortOptions(
    cohortOptions: CohortOption[],
    today: string,
): Promise<CohortSelection> {
    const response = await reportCheckerEvent({type: 'resolveCohort', cohortOptions});
    if (
        !isRecord(response) ||
        !hasExactKeys(response, ['type', 'selection']) ||
        response.type !== 'cohortSelection' ||
        !isRecord(response.selection)
    ) {
        throw new Error('INVALID_COHORT_SELECTION_RESPONSE');
    }
    const selection = response.selection;
    if (
        !hasExactKeys(selection, [
            'cohort_id',
            'cohort_status',
            'cohort_start_date',
            'cohort_end_date',
        ])
    ) {
        throw new Error('INVALID_COHORT_SELECTION_RESPONSE');
    }
    const cohortId = selection.cohort_id;
    const cohortStatus = selection.cohort_status;
    const startDate = selection.cohort_start_date;
    const endDate = selection.cohort_end_date;
    const validDate = (value: unknown): value is string | null =>
        value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value));
    if (
        (cohortId !== null &&
            (typeof cohortId !== 'string' ||
                !cohortId ||
                cohortId.length > 128 ||
                cohortId.trim() !== cohortId)) ||
        typeof cohortStatus !== 'string' ||
        !['active', 'upcoming', 'unknown', 'ended', 'none'].includes(cohortStatus) ||
        !validDate(startDate) ||
        !validDate(endDate)
    ) {
        throw new Error('INVALID_COHORT_SELECTION_RESPONSE');
    }
    return {
        cohort_id: cohortId,
        cohort_status: cohortStatus as CohortStatus,
        cohort_start_date: startDate,
        cohort_end_date: endDate,
        fetched_date: today,
    };
}

function parseAttendanceToday(data: unknown): AttendanceValue {
    return {
        morning_done: Boolean(isRecord(data) && data.checkedAt),
        evening_done: Boolean(isRecord(data) && data.checkedOutAt),
    };
}

async function fetchCohortSelection(): Promise<CohortSelection> {
    const url = 'https://jungle-lms.krafton.com/api/v2/me/cohorts';
    jsLog('debug', `fetchCohortSelection: GET ${url}`);

    try {
        const response = await fetch(url, {
            credentials: 'include',
            headers: {accept: 'application/json'},
        });
        jsLog(
            'debug',
            `fetchCohortSelection: response status=${response.status} statusText=${response.statusText}`,
        );

        if (response.status === 401) {
            jsLog('info', 'fetchCohortSelection: status=401 (login required)');
            cachedCohortOptions = null;
            cachedCohortDate = null;
            return {
                needs_login: true,
                cohort_id: null,
                cohort_status: 'unknown',
                cohort_start_date: null,
                cohort_end_date: null,
            };
        }
        if (!response.ok) {
            const body = await response.text();
            jsLog('warn', `fetchCohortSelection: status=${response.status}`);
            jsLog('debug', `fetchCohortSelection: error body length=${body.length}`);
            return {
                api_error: true,
                cohort_id: null,
                cohort_status: 'unknown',
                cohort_start_date: null,
                cohort_end_date: null,
            };
        }

        const data: unknown = await response.json();
        const cohorts = Array.isArray(data) ? data.filter(isRecord) : [];
        jsLog('debug', `fetchCohortSelection: cohorts count=${cohorts.length}`);
        const today = currentKstDateString();
        const cohortOptions = normalizeCohortOptions(cohorts);
        const selection = await resolveCohortOptions(cohortOptions, today);
        cachedCohortOptions = cohortOptions;
        cachedCohortDate = today;
        jsLog(
            'debug',
            `fetchCohortSelection: selected cohort status=${selection.cohort_status} startDate=${selection.cohort_start_date} endDate=${selection.cohort_end_date} (valid=${cohortOptions.length})`,
        );
        return selection;
    } catch (error: unknown) {
        jsLog('error', `fetchCohortSelection failed: ${errorMessage(error)}`);
        return {
            api_error: true,
            cohort_id: null,
            cohort_status: 'unknown',
            cohort_start_date: null,
            cohort_end_date: null,
        };
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
        jsLog(
            'debug',
            `fetchAttendance: response status=${response.status} statusText=${response.statusText}`,
        );

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
            cohort_start_date: null,
            cohort_end_date: null,
        };
    }

    const today = currentKstDateString();
    const selection =
        cachedCohortOptions && cachedCohortDate === today
            ? await resolveCohortOptions(cachedCohortOptions, today).catch((error: unknown) => {
                  jsLog('error', `resolveCohortOptions failed: ${errorMessage(error)}`);
                  return {
                      api_error: true,
                      cohort_id: null,
                      cohort_status: 'unknown',
                      cohort_start_date: null,
                      cohort_end_date: null,
                  } satisfies CohortSelection;
              })
            : await fetchCohortSelection();

    if (selection.api_error) {
        return {needs_login: false, morning_done: false, evening_done: false, api_error: true};
    }
    if (selection.needs_login) {
        cachedCohortOptions = null;
        cachedCohortDate = null;
        return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_start_date: null,
            cohort_end_date: null,
        };
    }

    if (!selection.cohort_id) {
        return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            cohort_status: selection.cohort_status,
            cohort_start_date: selection.cohort_start_date,
            cohort_end_date: selection.cohort_end_date,
        };
    }

    const attendance = await fetchAttendance(selection.cohort_id);
    if (!attendance) {
        jsLog('debug', 'checkAttendance: fetchAttendance returned null -> api_error');
        return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
            cohort_status: selection.cohort_status,
            cohort_start_date: selection.cohort_start_date,
            cohort_end_date: selection.cohort_end_date,
        };
    }
    if ('needs_login' in attendance) {
        jsLog('debug', 'checkAttendance: needs_login flag set, clearing cohort cache');
        cachedCohortOptions = null;
        cachedCohortDate = null;
        return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_start_date: null,
            cohort_end_date: null,
        };
    }

    jsLog(
        'debug',
        `checkAttendance: morning_done=${attendance.morning_done} evening_done=${attendance.evening_done}`,
    );
    return {
        needs_login: false,
        morning_done: attendance.morning_done,
        evening_done: attendance.evening_done,
        cohort_status: selection.cohort_status,
        cohort_start_date: selection.cohort_start_date,
        cohort_end_date: selection.cohort_end_date,
    };
}

function reportResult(result: AttendanceResult, generation: number): void {
    const status: AttendanceSnapshot = {
        generation,
        needs_login: result.needs_login,
        morning_done: result.morning_done,
        evening_done: result.evening_done,
        api_error: result.api_error ?? false,
        cohort_status: result.cohort_status ?? 'unknown',
        cohort_start_date: result.cohort_start_date ?? null,
        cohort_end_date: result.cohort_end_date ?? null,
    };
    jsLog(
        'debug',
        `result: needs_login=${status.needs_login} generation=${status.generation} morning=${status.morning_done} evening=${status.evening_done} cohort_status=${status.cohort_status} cohort_start_date=${status.cohort_start_date} cohort_end_date=${status.cohort_end_date}${status.api_error ? ' api_error=true' : ''}`,
    );
    void reportCheckerEvent({type: 'attendanceSnapshot', status})
        .then(expectAcknowledged)
        .catch((error: unknown) => {
            jsLog('warn', `report attendance snapshot failed: ${errorMessage(error)}`);
        });
}

function runCheck(reason: string): void {
    const generation = currentGeneration;
    if (checkInFlight) {
        queuedCheckGeneration = generation;
        jsLog('debug', `check queued, already running: ${reason}`);
        return;
    }

    checkInFlight = true;
    jsLog('debug', `check started: ${reason}`);
    void checkAttendance()
        .then((result) => reportResult(result, generation))
        .finally(() => {
            checkInFlight = false;
            if (queuedCheckGeneration !== null) {
                const queuedGeneration = queuedCheckGeneration;
                queuedCheckGeneration = null;
                if (queuedGeneration === currentGeneration) runCheck('queued-trigger');
            }
        });
}

void window.__TAURI__.event
    .listen<TriggerCheckPayload>('trigger-check', (event) => {
        const generation = event.payload?.generation;
        if (
            !Number.isSafeInteger(generation) ||
            typeof generation !== 'number' ||
            generation <= 0
        ) {
            jsLog('warn', 'invalid trigger-check generation');
            return;
        }
        currentGeneration = generation;
        reportCheckerReady();
        runCheck('rust-trigger');
    })
    .catch((error: unknown) => {
        jsLog('error', `trigger-check listener failed: ${errorMessage(error)}`);
    });

jsLog('info', 'checker loaded, waiting for trigger');
