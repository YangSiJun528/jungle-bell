import {describe, expect, expectTypeOf, it} from 'vitest';

import {
    AUTHENTICATION_STATUSES,
    PLATFORM_CAPABILITY_MATRIX,
    PLATFORM_SURFACES,
    PUSH_STATUSES,
    UPDATE_STATUSES,
    isAuthenticationState,
    isPushState,
    isUpdateState,
    type AuthenticationState,
    type AuthenticationStatus,
    type PlatformCapabilityMatrix,
    type PlatformCapabilityProfile,
    type PlatformSurface,
    type PushState,
    type PushStatus,
    type UpdateState,
    type UpdateStatus,
} from './status-model';

const EXPECTED_PLATFORM_CAPABILITY_MATRIX = {
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
} as const;

const EXPECTED_AUTHENTICATION_STATUSES = [
    'checking',
    'first-connect',
    'authenticated',
    'expired',
    'offline',
    'server-error',
    'recovering',
] as const;

const EXPECTED_PUSH_STATUSES = [
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

const EXPECTED_UPDATE_STATUSES = [
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

type ExpectedDiscriminatedState<Status extends string> = Status extends string
    ? {readonly status: Status}
    : never;

describe('platform capability matrix', () => {
    it('Web, PWA, PC의 여섯 capability를 원인까지 드러내는 값으로 고정한다', () => {
        expect(PLATFORM_SURFACES).toEqual(['web', 'pwa', 'pc']);
        expect(PLATFORM_CAPABILITY_MATRIX).toEqual(EXPECTED_PLATFORM_CAPABILITY_MATRIX);
        expectTypeOf<PlatformCapabilityMatrix>().toEqualTypeOf<
            typeof EXPECTED_PLATFORM_CAPABILITY_MATRIX
        >();
        expectTypeOf<PlatformCapabilityProfile<'web'>>().toEqualTypeOf<
            (typeof EXPECTED_PLATFORM_CAPABILITY_MATRIX)['web']
        >();
        expectTypeOf<PlatformCapabilityProfile<'pwa'>>().toEqualTypeOf<
            (typeof EXPECTED_PLATFORM_CAPABILITY_MATRIX)['pwa']
        >();
        expectTypeOf<PlatformCapabilityProfile<'pc'>>().toEqualTypeOf<
            (typeof EXPECTED_PLATFORM_CAPABILITY_MATRIX)['pc']
        >();
    });

    it('capability 셀을 boolean이나 null로 축약하지 않는다', () => {
        const capabilityValues = Object.values(PLATFORM_CAPABILITY_MATRIX).flatMap((profile) =>
            Object.values(profile),
        );

        expect(capabilityValues).toHaveLength(
            PLATFORM_SURFACES.length * Object.keys(PLATFORM_CAPABILITY_MATRIX.web).length,
        );
        expect(capabilityValues.every((value) => typeof value === 'string')).toBe(true);
        expect(capabilityValues).not.toContain(true);
        expect(capabilityValues).not.toContain(false);
        expect(capabilityValues).not.toContain(null);

        type CapabilityValue = PlatformCapabilityProfile[keyof PlatformCapabilityProfile];
        expectTypeOf<Extract<CapabilityValue, boolean | null>>().toEqualTypeOf<never>();
        expectTypeOf<keyof typeof PLATFORM_CAPABILITY_MATRIX>().toEqualTypeOf<PlatformSurface>();
    });
});

describe('platform lifecycle states', () => {
    it('인증 상태를 최초 연결, 만료, 연결 실패와 복구까지 구분한다', () => {
        expect(AUTHENTICATION_STATUSES).toEqual(EXPECTED_AUTHENTICATION_STATUSES);

        const states = AUTHENTICATION_STATUSES.map((status) => ({status}));
        expect(states.map(({status}) => status)).toEqual(EXPECTED_AUTHENTICATION_STATUSES);
        expectTypeOf<AuthenticationStatus>().toEqualTypeOf<
            (typeof EXPECTED_AUTHENTICATION_STATUSES)[number]
        >();
        expectTypeOf<AuthenticationState>().toEqualTypeOf<
            ExpectedDiscriminatedState<(typeof EXPECTED_AUTHENTICATION_STATUSES)[number]>
        >();
        expect(states.every(isAuthenticationState)).toBe(true);
    });

    it('푸시 상태를 권한, 로컬 구독, 서버 등록과 실제 도착 확인으로 구분한다', () => {
        expect(PUSH_STATUSES).toEqual(EXPECTED_PUSH_STATUSES);

        const states = PUSH_STATUSES.map((status) => ({status}));
        expect(states.map(({status}) => status)).toEqual(EXPECTED_PUSH_STATUSES);
        expectTypeOf<PushStatus>().toEqualTypeOf<(typeof EXPECTED_PUSH_STATUSES)[number]>();
        expectTypeOf<PushState>().toEqualTypeOf<
            ExpectedDiscriminatedState<(typeof EXPECTED_PUSH_STATUSES)[number]>
        >();
        expect(states.every(isPushState)).toBe(true);
    });

    it('업데이트 상태를 확인, 배포 단계, 재시작과 실패까지 구분한다', () => {
        expect(UPDATE_STATUSES).toEqual(EXPECTED_UPDATE_STATUSES);

        const states = UPDATE_STATUSES.map((status) => ({status}));
        expect(states.map(({status}) => status)).toEqual(EXPECTED_UPDATE_STATUSES);
        expectTypeOf<UpdateStatus>().toEqualTypeOf<(typeof EXPECTED_UPDATE_STATUSES)[number]>();
        expectTypeOf<UpdateState>().toEqualTypeOf<
            ExpectedDiscriminatedState<(typeof EXPECTED_UPDATE_STATUSES)[number]>
        >();
        expect(states.every(isUpdateState)).toBe(true);
    });

    it('상태 계약에 boolean과 null을 대입할 수 없다', () => {
        expectTypeOf<boolean>().not.toMatchTypeOf<AuthenticationState>();
        expectTypeOf<null>().not.toMatchTypeOf<AuthenticationState>();
        expectTypeOf<boolean>().not.toMatchTypeOf<PushState>();
        expectTypeOf<null>().not.toMatchTypeOf<PushState>();
        expectTypeOf<boolean>().not.toMatchTypeOf<UpdateState>();
        expectTypeOf<null>().not.toMatchTypeOf<UpdateState>();
    });

    it('런타임 경계도 boolean, null, 알 수 없는 status를 상태로 받지 않는다', () => {
        const invalidStates: unknown[] = [
            true,
            false,
            null,
            undefined,
            'checking',
            {},
            {status: true},
            {status: null},
            {status: 'unknown'},
        ];

        for (const value of invalidStates) {
            expect(isAuthenticationState(value)).toBe(false);
            expect(isPushState(value)).toBe(false);
            expect(isUpdateState(value)).toBe(false);
        }

        expect(isAuthenticationState({status: 'unconnected'})).toBe(false);
        expect(isPushState({status: 'ready'})).toBe(false);
        expect(isUpdateState({status: 'available'})).toBe(false);
        expect(isAuthenticationState({status: 'arrived'})).toBe(false);
        expect(isAuthenticationState({status: 'installing'})).toBe(false);
        expect(isPushState({status: 'authenticated'})).toBe(false);
        expect(isPushState({status: 'mandatory'})).toBe(false);
        expect(isUpdateState({status: 'expired'})).toBe(false);
        expect(isUpdateState({status: 'denied'})).toBe(false);
        expect(isAuthenticationState({status: 'expired'})).toBe(true);
        expect(isPushState({status: 'registered-server'})).toBe(true);
        expect(isUpdateState({status: 'verifying'})).toBe(true);
    });
});
