export type PersonalSurface = 'desktop' | 'companion';

export type PersonalFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type PersonalInvoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

export interface AttendancePreferences {
    morning: boolean;
    evening: boolean;
    skipSunday: boolean;
    skipAttendanceDate: string | null;
}

export interface MealPreferencesInput {
    enabled: boolean;
    breakfast: boolean;
    lunch: boolean;
    dinner: boolean;
}

export interface MealPreferences extends MealPreferencesInput {
    updatedAtEpochMs: number;
}

export type LaundryApplianceKind = 'washer' | 'dryer';

export interface LaundryWatchInput {
    machineId: string;
    appliance: LaundryApplianceKind;
    sessionId: string | null;
    notifyBeforeMinutes: number;
    notifyWhenAvailable: boolean;
}

export interface LaundryWatch extends LaundryWatchInput {
    id: string;
    status: 'active' | 'completed' | 'cancelled';
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
}

export interface LaundryQueueInput {
    machineId: string | null;
    appliance: LaundryApplianceKind;
}

export interface LaundryQueueEntry extends LaundryQueueInput {
    id: string;
    status: 'waiting' | 'claimed' | 'cancelled' | 'expired';
    joinedAtEpochMs: number;
    leftAtEpochMs: number | null;
    position: number | null;
}

export interface DashboardPersonalApi {
    getAttendancePreferences(surface: PersonalSurface): Promise<AttendancePreferences>;
    updateAttendancePreferences(
        surface: PersonalSurface,
        input: AttendancePreferences,
    ): Promise<AttendancePreferences>;
    getMealPreferences(surface: PersonalSurface): Promise<MealPreferences>;
    updateMealPreferences(surface: PersonalSurface, input: MealPreferencesInput): Promise<MealPreferences>;
    listLaundryWatches(surface: PersonalSurface): Promise<LaundryWatch[]>;
    createLaundryWatch(surface: PersonalSurface, input: LaundryWatchInput): Promise<LaundryWatch>;
    deleteLaundryWatch(surface: PersonalSurface, id: string): Promise<void>;
    listLaundryQueue(surface: PersonalSurface): Promise<LaundryQueueEntry[]>;
    joinLaundryQueue(surface: PersonalSurface, input: LaundryQueueInput): Promise<LaundryQueueEntry>;
    leaveLaundryQueue(surface: PersonalSurface, id: string): Promise<void>;
}

const LAUNDRY_WATCH_ID = /^jbw_[0-9a-f]{64}$/u;
const LAUNDRY_QUEUE_ID = /^jbq_[0-9a-f]{64}$/u;

export function createDashboardPersonalApi(options: {
    platformBase: string;
    fetcher: PersonalFetch;
    invokeCommand: PersonalInvoke;
}): DashboardPersonalApi {
    const mobileResponse = (path: string, init: RequestInit = {}): Promise<Response> => options.fetcher(
        `${options.platformBase}/api/mobile${path}`,
        {
            ...init,
            credentials: 'include',
            cache: 'no-store',
            headers: {
                accept: 'application/json',
                ...(init.body === undefined ? {} : {'content-type': 'application/json'}),
                ...init.headers,
            },
        },
    );

    const mobileJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
        const response = await mobileResponse(path, init);
        if (!response.ok) throw await responseError(response);
        const type = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!type.includes('application/json')) throw invalidResponse();
        return response.json();
    };

    const value = (
        surface: PersonalSurface,
        command: string,
        path: string,
        init?: RequestInit,
        args?: Record<string, unknown>,
    ): Promise<unknown> => surface === 'desktop'
        ? options.invokeCommand(command, args)
        : mobileJson(path, init ?? {method: 'GET'});

    const noContent = async (
        surface: PersonalSurface,
        command: string,
        path: string,
        args: Record<string, unknown>,
    ): Promise<void> => {
        if (surface === 'desktop') {
            const result = await options.invokeCommand(command, args);
            if (result !== null && result !== undefined) throw invalidResponse();
            return;
        }
        const response = await mobileResponse(path, {method: 'DELETE'});
        if (!response.ok) throw await responseError(response);
        if (response.status !== 204) throw invalidResponse();
    };

    return {
        async getAttendancePreferences(surface) {
            return parseAttendancePreferences(await value(
                surface, 'get_attendance_preferences', '/attendance/preferences',
            ));
        },
        async updateAttendancePreferences(surface, input) {
            const body = attendancePreferencesInput(input);
            return parseAttendancePreferences(await value(
                surface, 'update_attendance_preferences', '/attendance/preferences',
                {method: 'PUT', body: JSON.stringify(body)}, {input: body},
            ));
        },
        async getMealPreferences(surface) {
            return parseMealPreferences(await value(
                surface, 'get_meal_preferences', '/meal-preferences',
            ));
        },
        async updateMealPreferences(surface, input) {
            const body = mealPreferencesInput(input);
            return parseMealPreferences(await value(
                surface, 'update_meal_preferences', '/meal-preferences',
                {method: 'PUT', body: JSON.stringify(body)}, {input: body},
            ));
        },
        async listLaundryWatches(surface) {
            return parseLaundryWatchList(await value(
                surface, 'list_laundry_watches', '/laundry-watches',
            ));
        },
        async createLaundryWatch(surface, input) {
            const body = laundryWatchInput(input);
            return parseLaundryWatch(await value(
                surface, 'create_laundry_watch', '/laundry-watches',
                {method: 'POST', body: JSON.stringify(body)}, {input: body},
            ));
        },
        async deleteLaundryWatch(surface, id) {
            assertClientIdentifier(id, LAUNDRY_WATCH_ID);
            await noContent(
                surface, 'delete_laundry_watch', `/laundry-watches/${encodeURIComponent(id)}`, {watchId: id},
            );
        },
        async listLaundryQueue(surface) {
            return parseLaundryQueueList(await value(
                surface, 'list_laundry_queue', '/laundry-queue',
            ));
        },
        async joinLaundryQueue(surface, input) {
            const body = laundryQueueInput(input);
            return parseLaundryQueueEntry(await value(
                surface, 'join_laundry_queue', '/laundry-queue',
                {method: 'POST', body: JSON.stringify(body)}, {input: body},
            ));
        },
        async leaveLaundryQueue(surface, id) {
            assertClientIdentifier(id, LAUNDRY_QUEUE_ID);
            await noContent(
                surface, 'leave_laundry_queue', `/laundry-queue/${encodeURIComponent(id)}`, {entryId: id},
            );
        },
    };
}

function parseAttendancePreferences(value: unknown): AttendancePreferences {
    const source = exactRecord(value, ['morning', 'evening', 'skipSunday', 'skipAttendanceDate']);
    return {
        morning: requiredBoolean(source.morning),
        evening: requiredBoolean(source.evening),
        skipSunday: requiredBoolean(source.skipSunday),
        skipAttendanceDate: source.skipAttendanceDate === null ? null : calendarDate(source.skipAttendanceDate),
    };
}

function parseMealPreferences(value: unknown): MealPreferences {
    const source = exactRecord(value, ['enabled', 'breakfast', 'lunch', 'dinner', 'updatedAtEpochMs']);
    return {
        enabled: requiredBoolean(source.enabled),
        breakfast: requiredBoolean(source.breakfast),
        lunch: requiredBoolean(source.lunch),
        dinner: requiredBoolean(source.dinner),
        updatedAtEpochMs: epochMilliseconds(source.updatedAtEpochMs),
    };
}

function parseLaundryWatchList(value: unknown): LaundryWatch[] {
    const source = exactRecord(value, ['watches']);
    return boundedArray(source.watches, 128).map(parseLaundryWatch);
}

function parseLaundryWatch(value: unknown): LaundryWatch {
    const source = exactRecord(value, [
        'id', 'machineId', 'appliance', 'sessionId', 'notifyBeforeMinutes',
        'notifyWhenAvailable', 'status', 'createdAtEpochMs', 'updatedAtEpochMs',
    ]);
    const id = boundedString(source.id, 68);
    assertResponseIdentifier(id, LAUNDRY_WATCH_ID);
    const status = source.status;
    if (status !== 'active' && status !== 'completed' && status !== 'cancelled') throw invalidResponse();
    const createdAtEpochMs = epochMilliseconds(source.createdAtEpochMs);
    const updatedAtEpochMs = epochMilliseconds(source.updatedAtEpochMs);
    if (updatedAtEpochMs < createdAtEpochMs) throw invalidResponse();
    return {
        id,
        machineId: boundedString(source.machineId, 128),
        appliance: applianceKind(source.appliance),
        sessionId: source.sessionId === null ? null : boundedString(source.sessionId, 256),
        notifyBeforeMinutes: boundedInteger(source.notifyBeforeMinutes, 0, 180),
        notifyWhenAvailable: requiredBoolean(source.notifyWhenAvailable),
        status,
        createdAtEpochMs,
        updatedAtEpochMs,
    };
}

function parseLaundryQueueList(value: unknown): LaundryQueueEntry[] {
    const source = exactRecord(value, ['entries']);
    return boundedArray(source.entries, 32).map(parseLaundryQueueEntry);
}

function parseLaundryQueueEntry(value: unknown): LaundryQueueEntry {
    const source = exactRecord(value, [
        'id', 'machineId', 'appliance', 'status', 'joinedAtEpochMs', 'leftAtEpochMs', 'position',
    ]);
    const id = boundedString(source.id, 68);
    assertResponseIdentifier(id, LAUNDRY_QUEUE_ID);
    const status = source.status;
    if (status !== 'waiting' && status !== 'claimed' && status !== 'cancelled' && status !== 'expired') {
        throw invalidResponse();
    }
    const joinedAtEpochMs = epochMilliseconds(source.joinedAtEpochMs);
    const leftAtEpochMs = source.leftAtEpochMs === null ? null : epochMilliseconds(source.leftAtEpochMs);
    const position = source.position === null ? null : boundedInteger(source.position, 1, 100_000);
    if ((status === 'waiting' && (leftAtEpochMs !== null || position === null))
        || (status !== 'waiting' && (leftAtEpochMs === null || position !== null))
        || (leftAtEpochMs !== null && leftAtEpochMs < joinedAtEpochMs)) throw invalidResponse();
    return {
        id,
        machineId: source.machineId === null ? null : boundedString(source.machineId, 128),
        appliance: applianceKind(source.appliance),
        status,
        joinedAtEpochMs,
        leftAtEpochMs,
        position,
    };
}

function attendancePreferencesInput(input: AttendancePreferences): AttendancePreferences {
    try {
        return {
            morning: requiredBoolean(input.morning),
            evening: requiredBoolean(input.evening),
            skipSunday: requiredBoolean(input.skipSunday),
            skipAttendanceDate: input.skipAttendanceDate === null ? null : calendarDate(input.skipAttendanceDate),
        };
    } catch {
        throw invalidArgument();
    }
}

function mealPreferencesInput(input: MealPreferencesInput): MealPreferencesInput {
    try {
        return {
            enabled: requiredBoolean(input.enabled),
            breakfast: requiredBoolean(input.breakfast),
            lunch: requiredBoolean(input.lunch),
            dinner: requiredBoolean(input.dinner),
        };
    } catch {
        throw invalidArgument();
    }
}

function laundryWatchInput(input: LaundryWatchInput): LaundryWatchInput {
    try {
        return {
            machineId: boundedString(input.machineId, 128),
            appliance: applianceKind(input.appliance),
            sessionId: input.sessionId === null ? null : boundedString(input.sessionId, 256),
            notifyBeforeMinutes: boundedInteger(input.notifyBeforeMinutes, 0, 180),
            notifyWhenAvailable: requiredBoolean(input.notifyWhenAvailable),
        };
    } catch {
        throw invalidArgument();
    }
}

function laundryQueueInput(input: LaundryQueueInput): LaundryQueueInput {
    try {
        return {
            machineId: input.machineId === null ? null : boundedString(input.machineId, 128),
            appliance: applianceKind(input.appliance),
        };
    } catch {
        throw invalidArgument();
    }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    const actual = Object.keys(source);
    if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) throw invalidResponse();
    return source;
}

function boundedArray(value: unknown, maximum: number): unknown[] {
    if (!Array.isArray(value) || value.length > maximum) throw invalidResponse();
    return value;
}

function boundedString(value: unknown, maximum: number): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value) {
        throw invalidResponse();
    }
    return value;
}

function requiredBoolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw invalidResponse();
    return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw invalidResponse();
    }
    return value;
}

function epochMilliseconds(value: unknown): number {
    return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function applianceKind(value: unknown): LaundryApplianceKind {
    if (value !== 'washer' && value !== 'dryer') throw invalidResponse();
    return value;
}

function calendarDate(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalidResponse();
    const [yearText, monthText, dayText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw invalidResponse();
    }
    return value;
}

function assertResponseIdentifier(value: string, pattern: RegExp): void {
    if (!pattern.test(value)) throw invalidResponse();
}

function assertClientIdentifier(value: string, pattern: RegExp): void {
    if (!pattern.test(value)) throw invalidArgument();
}

async function responseError(response: Response): Promise<Error> {
    try {
        const source = exactRecord(await response.json(), ['error']);
        if (typeof source.error === 'string' && /^[A-Z][A-Z0-9_-]{0,127}$/u.test(source.error)) {
            return new Error(source.error);
        }
    } catch {
        // Fall through to the stable HTTP code.
    }
    return new Error(`HTTP_${response.status}`);
}

function invalidArgument(): Error {
    return new Error('API_CLIENT_INVALID_ARGUMENT');
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
