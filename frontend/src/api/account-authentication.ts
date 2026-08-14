const ACCOUNT_AUTHENTICATION_ERRORS = new Set([
    'HTTP_401',
    'UNAUTHORIZED',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'MOBILE_SESSION_REQUIRED',
]);

export function accountAuthenticationRequired(error: unknown): boolean {
    return error instanceof Error && ACCOUNT_AUTHENTICATION_ERRORS.has(error.message);
}
