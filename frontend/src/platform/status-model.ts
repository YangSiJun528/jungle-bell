export const PLATFORM_SURFACES = ['web', 'pwa', 'pc'] as const;

export type PlatformSurface = (typeof PLATFORM_SURFACES)[number];

interface PlatformCapabilitySchema {
    readonly publicFeatures: 'available';
    readonly personalFeatures:
        | 'install-required'
        | 'connection-required'
        | 'authentication-required';
    readonly installation: 'pwa-install' | 'installed' | 'native-app';
    readonly authentication: 'not-supported' | 'mobile-session' | 'lms-and-server';
    readonly notifications: 'install-required' | 'web-push' | 'os-notification';
    readonly updates: 'browser-managed' | 'service-worker' | 'native-updater';
}

export const PLATFORM_CAPABILITY_MATRIX = {
    web: {
        publicFeatures: 'available',
        personalFeatures: 'install-required',
        installation: 'pwa-install',
        authentication: 'not-supported',
        notifications: 'install-required',
        updates: 'browser-managed',
    },
    pwa: {
        publicFeatures: 'available',
        personalFeatures: 'connection-required',
        installation: 'installed',
        authentication: 'mobile-session',
        notifications: 'web-push',
        updates: 'service-worker',
    },
    pc: {
        publicFeatures: 'available',
        personalFeatures: 'authentication-required',
        installation: 'native-app',
        authentication: 'lms-and-server',
        notifications: 'os-notification',
        updates: 'native-updater',
    },
} as const satisfies Readonly<Record<PlatformSurface, PlatformCapabilitySchema>>;

export type PlatformCapabilityMatrix = typeof PLATFORM_CAPABILITY_MATRIX;
export type PlatformCapabilityProfile<Surface extends PlatformSurface = PlatformSurface> =
    PlatformCapabilityMatrix[Surface];

export const AUTHENTICATION_STATUSES = [
    'checking',
    'first-connect',
    'authenticated',
    'expired',
    'offline',
    'server-error',
    'recovering',
] as const;

export const PUSH_STATUSES = [
    'unsupported',
    'permission-default',
    'denied',
    'subscribed-local',
    'registered-server',
    'test-sending',
    'arrived',
    'not-arrived',
    'error',
] as const;

export const UPDATE_STATUSES = [
    'checking',
    'latest',
    'optional',
    'mandatory',
    'downloading',
    'verifying',
    'installing',
    'restart-required',
    'failed',
] as const;

export type AuthenticationStatus = (typeof AUTHENTICATION_STATUSES)[number];
export type PushStatus = (typeof PUSH_STATUSES)[number];
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

type DiscriminatedStatus<Status extends string> = {
    readonly [Value in Status]: {readonly status: Value};
}[Status];

export type AuthenticationState = DiscriminatedStatus<AuthenticationStatus>;
export type PushState = DiscriminatedStatus<PushStatus>;
export type UpdateState = DiscriminatedStatus<UpdateStatus>;

const authenticationStatusSet: ReadonlySet<AuthenticationStatus> = new Set(AUTHENTICATION_STATUSES);
const pushStatusSet: ReadonlySet<PushStatus> = new Set(PUSH_STATUSES);
const updateStatusSet: ReadonlySet<UpdateStatus> = new Set(UPDATE_STATUSES);

function hasKnownStatus<Status extends string>(
    value: unknown,
    statuses: ReadonlySet<Status>,
): value is DiscriminatedStatus<Status> {
    if (typeof value !== 'object' || value === null) return false;
    const status = Reflect.get(value, 'status');
    const knownStatuses: ReadonlySet<string> = statuses;
    return typeof status === 'string' && knownStatuses.has(status);
}

export function isAuthenticationState(value: unknown): value is AuthenticationState {
    return hasKnownStatus<AuthenticationStatus>(value, authenticationStatusSet);
}

export function isPushState(value: unknown): value is PushState {
    return hasKnownStatus<PushStatus>(value, pushStatusSet);
}

export function isUpdateState(value: unknown): value is UpdateState {
    return hasKnownStatus<UpdateStatus>(value, updateStatusSet);
}
