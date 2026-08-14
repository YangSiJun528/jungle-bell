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

export interface DashboardPersonalApi {
    getAttendancePreferences(): Promise<AttendancePreferences>;
    updateAttendancePreferences(input: AttendancePreferences): Promise<AttendancePreferences>;
    getMealPreferences(): Promise<MealPreferences>;
    updateMealPreferences(input: MealPreferencesInput): Promise<MealPreferences>;
    listLaundryWatches(): Promise<LaundryWatch[]>;
    createLaundryWatch(input: LaundryWatchInput): Promise<LaundryWatch>;
    deleteLaundryWatch(id: string): Promise<void>;
}

const errorResponseSchema = z.looseObject({
    error: z.string().regex(/^[A-Z][A-Z0-9_-]{0,127}$/u),
});

export function createDashboardPersonalApi(options: {
    httpClient: HttpApiClient;
}): DashboardPersonalApi {
    const request = (
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
        const accountPath = `/api/me/${path.replace(/^\/+/, '')}` as const;
        return options.httpClient.accountResponse(accountPath, init);
    };

    const value = async <T>(
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
        async getAttendancePreferences() {
            return value(
                attendancePreferencesSchema,
                () => request('GET', '/attendance/preferences'),
            );
        },
        async updateAttendancePreferences(input) {
            const body = parseInput(attendancePreferencesSchema, input);
            return value(
                attendancePreferencesSchema,
                () => request('PUT', '/attendance/preferences', body),
            );
        },
        async getMealPreferences() {
            return value(
                mealPreferencesSchema,
                () => request('GET', '/meal-preferences'),
            );
        },
        async updateMealPreferences(input) {
            const body = parseInput(mealPreferencesInputSchema, input);
            return value(
                mealPreferencesSchema,
                () => request('PUT', '/meal-preferences', body),
            );
        },
        async listLaundryWatches() {
            const result = await value(
                laundryWatchListSchema,
                () => request('GET', '/laundry-watches'),
            );
            return result.watches;
        },
        async createLaundryWatch(input) {
            const body = parseInput(laundryWatchInputSchema, input);
            return value(
                laundryWatchSchema,
                () => request('POST', '/laundry-watches', body),
            );
        },
        async deleteLaundryWatch(id) {
            const watchId = parseInput(laundryWatchIdSchema, id);
            await noContent(
                () => request('DELETE', `/laundry-watches/${encodeURIComponent(watchId)}`),
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
