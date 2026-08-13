import {z, type ZodType} from 'zod';
import {
    attendancePreferencesSchema,
    laundryWatchIdSchema,
    laundryWatchInputSchema,
    laundryWatchListSchema,
    laundryWatchSchema,
    mealPreferencesInputSchema,
    mealPreferencesSchema,
    type AttendancePreferences,
    type LaundryApplianceKind,
    type LaundryWatch,
    type LaundryWatchInput,
    type MealPreferences,
    type MealPreferencesInput,
} from './personal-contract';
import type {HttpApiClient} from './http-api-client';

export type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryWatch,
    LaundryWatchInput,
    MealPreferences,
    MealPreferencesInput,
};

export type PersonalSurface = 'desktop' | 'companion';

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
}

const errorResponseSchema = z.looseObject({
    error: z.string().regex(/^[A-Z][A-Z0-9_-]{0,127}$/u),
});

export function createDashboardPersonalApi(options: {
    httpClient: HttpApiClient;
}): DashboardPersonalApi {
    const request = (
        surface: PersonalSurface,
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<Response> => {
        const headers = new Headers();
        headers.set('accept', 'application/json');
        if (body !== undefined) headers.set('content-type', 'application/json');
        const init: RequestInit = {
            method,
            headers,
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        };
        const desktopPath = `/api/desktop-ui/${path.replace(/^\/+/, '')}` as const;
        const companionPath = `/api/mobile/${path.replace(/^\/+/, '')}` as const;
        return surface === 'desktop'
            ? options.httpClient.desktopResponse(desktopPath, init)
            : options.httpClient.companionResponse(companionPath, init);
    };

    const value = async <T>(
        surface: PersonalSurface,
        schema: ZodType<T>,
        response: () => Promise<Response>,
    ): Promise<T> => responseValue(schema, await response());

    const noContent = async (
        responseRequest: () => Promise<Response>,
    ): Promise<void> => {
        const response = await responseRequest();
        if (!response.ok) throw await responseError(response);
        if (response.status !== 204) throw invalidResponse();
    };

    return {
        async getAttendancePreferences(surface) {
            return value(
                surface,
                attendancePreferencesSchema,
                () => request(surface, 'GET', '/attendance/preferences'),
            );
        },
        async updateAttendancePreferences(surface, input) {
            const body = parseInput(attendancePreferencesSchema, input);
            return value(
                surface,
                attendancePreferencesSchema,
                () => request(surface, 'PUT', '/attendance/preferences', body),
            );
        },
        async getMealPreferences(surface) {
            return value(
                surface,
                mealPreferencesSchema,
                () => request(surface, 'GET', '/meal-preferences'),
            );
        },
        async updateMealPreferences(surface, input) {
            const body = parseInput(mealPreferencesInputSchema, input);
            return value(
                surface,
                mealPreferencesSchema,
                () => request(surface, 'PUT', '/meal-preferences', body),
            );
        },
        async listLaundryWatches(surface) {
            const result = await value(
                surface,
                laundryWatchListSchema,
                () => request(surface, 'GET', '/laundry-watches'),
            );
            return result.watches;
        },
        async createLaundryWatch(surface, input) {
            const body = parseInput(laundryWatchInputSchema, input);
            return value(
                surface,
                laundryWatchSchema,
                () => request(surface, 'POST', '/laundry-watches', body),
            );
        },
        async deleteLaundryWatch(surface, id) {
            const watchId = parseInput(laundryWatchIdSchema, id);
            await noContent(
                () => request(surface, 'DELETE', `/laundry-watches/${encodeURIComponent(watchId)}`),
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
    try {
        return parseResponse(schema, await response.json());
    } catch (error) {
        if (error instanceof Error && error.message === 'API_RESPONSE_INVALID') throw error;
        throw invalidResponse();
    }
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
