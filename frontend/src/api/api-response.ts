import {z, type ZodType} from 'zod';

const errorResponseSchema = z.looseObject({
    error: z.string().regex(/^[A-Z][A-Z0-9_-]{0,127}$/u),
});

export function invalidArgument(): Error {
    return new Error('API_CLIENT_INVALID_ARGUMENT');
}

export function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalidArgument();
    return result.data;
}

export function parseResponse<T>(schema: ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalidResponse();
    return result.data;
}

export async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) throw await responseError(response);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) throw invalidResponse();
    try {
        return await response.json();
    } catch {
        throw invalidResponse();
    }
}

export async function responseValue<T>(schema: ZodType<T>, response: Response): Promise<T> {
    return parseResponse(schema, await responseJson(response));
}

export async function responseNoContent(response: Response): Promise<void> {
    if (!response.ok) throw await responseError(response);
    if (response.status !== 204) throw invalidResponse();
}

export async function safeResponseJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export async function responseError(response: Response): Promise<Error> {
    const parsed = errorResponseSchema.safeParse(await safeResponseJson(response));
    return new Error(parsed.success ? parsed.data.error : `HTTP_${response.status}`);
}
