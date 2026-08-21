import type {ZodType} from 'zod';

import {parseInput, responseNoContent, responseValue} from './api-response';
import type {HttpApiClient} from './http-api-client';
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
    type LaundryNotificationMode,
    type LaundryWatch,
    type LaundryWatchInput,
    type MealPreferences,
    type MealPreferencesInput,
} from './personal-contract';

export type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryNotificationMode,
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

async function responseData<T>(schema: ZodType<T>, response: () => Promise<Response>): Promise<T> {
    return responseValue(schema, await response());
}

async function expectNoContent(responseRequest: () => Promise<Response>): Promise<void> {
    await responseNoContent(await responseRequest());
}

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

    return {
        async getAttendancePreferences() {
            return responseData(attendancePreferencesSchema, () =>
                request('GET', '/attendance/preferences'),
            );
        },
        async updateAttendancePreferences(input) {
            const body = parseInput(attendancePreferencesSchema, input);
            return responseData(attendancePreferencesSchema, () =>
                request('PUT', '/attendance/preferences', body),
            );
        },
        async getMealPreferences() {
            return responseData(mealPreferencesSchema, () => request('GET', '/meal-preferences'));
        },
        async updateMealPreferences(input) {
            const body = parseInput(mealPreferencesInputSchema, input);
            return responseData(mealPreferencesSchema, () =>
                request('PUT', '/meal-preferences', body),
            );
        },
        async listLaundryWatches() {
            const result = await responseData(laundryWatchListSchema, () =>
                request('GET', '/laundry-watches'),
            );
            return result.watches;
        },
        async createLaundryWatch(input) {
            const body = parseInput(laundryWatchInputSchema, input);
            return responseData(laundryWatchSchema, () =>
                request('POST', '/laundry-watches', body),
            );
        },
        async deleteLaundryWatch(id) {
            const watchId = parseInput(laundryWatchIdSchema, id);
            await expectNoContent(() =>
                request('DELETE', `/laundry-watches/${encodeURIComponent(watchId)}`),
            );
        },
    };
}
