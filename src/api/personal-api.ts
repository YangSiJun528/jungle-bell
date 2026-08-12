import {hc} from 'hono/client';
import {z, type ZodType} from 'zod';
import {
    attendancePreferencesSchema,
    laundryQueueEntrySchema,
    laundryQueueIdSchema,
    laundryQueueInputSchema,
    laundryQueueListSchema,
    laundryWatchIdSchema,
    laundryWatchInputSchema,
    laundryWatchListSchema,
    laundryWatchSchema,
    mealPreferencesInputSchema,
    mealPreferencesSchema,
    type AttendancePreferences,
    type LaundryApplianceKind,
    type LaundryQueueEntry,
    type LaundryQueueInput,
    type LaundryWatch,
    type LaundryWatchInput,
    type MealPreferences,
    type MealPreferencesInput,
} from '../../server/src/http/contracts/personal-schemas';
import type {PersonalRoutes} from '../../server/src/http/contracts/personal';

export type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryQueueEntry,
    LaundryQueueInput,
    LaundryWatch,
    LaundryWatchInput,
    MealPreferences,
    MealPreferencesInput,
};

export type PersonalSurface = 'desktop' | 'companion';

export type PersonalFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type PersonalInvoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

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

const errorResponseSchema = z.looseObject({
    error: z.string().regex(/^[A-Z][A-Z0-9_-]{0,127}$/u),
});

export function createDashboardPersonalApi(options: {
    platformBase: string;
    fetcher: PersonalFetch;
    invokeCommand: PersonalInvoke;
}): DashboardPersonalApi {
    const rpcFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('accept', 'application/json');
        return options.fetcher(input, {
            ...init,
            credentials: 'include',
            cache: 'no-store',
            headers,
        });
    };
    const mobile = hc<PersonalRoutes>(`${options.platformBase}/api/mobile`, {fetch: rpcFetch});

    const value = async <T>(
        surface: PersonalSurface,
        command: string,
        schema: ZodType<T>,
        mobileRequest: () => Promise<Response>,
        args?: Record<string, unknown>,
    ): Promise<T> => surface === 'desktop'
        ? parseResponse(schema, await options.invokeCommand(command, args))
        : responseValue(schema, await mobileRequest());

    const noContent = async (
        surface: PersonalSurface,
        command: string,
        mobileRequest: () => Promise<Response>,
        args: Record<string, unknown>,
    ): Promise<void> => {
        if (surface === 'desktop') {
            const result = await options.invokeCommand(command, args);
            if (result !== null && result !== undefined) throw invalidResponse();
            return;
        }
        const response = await mobileRequest();
        if (!response.ok) throw await responseError(response);
        if (response.status !== 204) throw invalidResponse();
    };

    return {
        async getAttendancePreferences(surface) {
            return value(
                surface,
                'get_attendance_preferences',
                attendancePreferencesSchema,
                () => mobile.attendance.preferences.$get(),
            );
        },
        async updateAttendancePreferences(surface, input) {
            const body = parseInput(attendancePreferencesSchema, input);
            return value(
                surface,
                'update_attendance_preferences',
                attendancePreferencesSchema,
                () => mobile.attendance.preferences.$put({json: body}),
                {input: body},
            );
        },
        async getMealPreferences(surface) {
            return value(
                surface,
                'get_meal_preferences',
                mealPreferencesSchema,
                () => mobile['meal-preferences'].$get(),
            );
        },
        async updateMealPreferences(surface, input) {
            const body = parseInput(mealPreferencesInputSchema, input);
            return value(
                surface,
                'update_meal_preferences',
                mealPreferencesSchema,
                () => mobile['meal-preferences'].$put({json: body}),
                {input: body},
            );
        },
        async listLaundryWatches(surface) {
            const result = await value(
                surface,
                'list_laundry_watches',
                laundryWatchListSchema,
                () => mobile['laundry-watches'].$get(),
            );
            return result.watches;
        },
        async createLaundryWatch(surface, input) {
            const body = parseInput(laundryWatchInputSchema, input);
            return value(
                surface,
                'create_laundry_watch',
                laundryWatchSchema,
                () => mobile['laundry-watches'].$post({json: body}),
                {input: body},
            );
        },
        async deleteLaundryWatch(surface, id) {
            const watchId = parseInput(laundryWatchIdSchema, id);
            await noContent(
                surface,
                'delete_laundry_watch',
                () => mobile['laundry-watches'][':id'].$delete({param: {id: watchId}}),
                {watchId},
            );
        },
        async listLaundryQueue(surface) {
            const result = await value(
                surface,
                'list_laundry_queue',
                laundryQueueListSchema,
                () => mobile['laundry-queue'].$get(),
            );
            return result.entries;
        },
        async joinLaundryQueue(surface, input) {
            const body = parseInput(laundryQueueInputSchema, input);
            return value(
                surface,
                'join_laundry_queue',
                laundryQueueEntrySchema,
                () => mobile['laundry-queue'].$post({json: body}),
                {input: body},
            );
        },
        async leaveLaundryQueue(surface, id) {
            const entryId = parseInput(laundryQueueIdSchema, id);
            await noContent(
                surface,
                'leave_laundry_queue',
                () => mobile['laundry-queue'][':id'].$delete({param: {id: entryId}}),
                {entryId},
            );
        },
    };
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalidArgument();
    return result.data;
}

function parseResponse<T>(schema: ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalidResponse();
    return result.data;
}

async function responseValue<T>(schema: ZodType<T>, response: Response): Promise<T> {
    if (!response.ok) throw await responseError(response);
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!type.includes('application/json')) throw invalidResponse();
    return parseResponse(schema, await response.json());
}

async function responseError(response: Response): Promise<Error> {
    try {
        const parsed = errorResponseSchema.safeParse(await response.json());
        if (parsed.success) return new Error(parsed.data.error);
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
