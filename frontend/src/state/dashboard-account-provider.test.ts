import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

import {
    browserSessionObservation,
    transitionCookieSessionAccess,
    type BrowserSessionQueryState,
} from './dashboard-account-state';

const providerSource = readFileSync(new URL('./dashboard-account.tsx', import.meta.url), 'utf8');
const session = {authenticated: true as const, expiresAt: '2026-09-10T00:00:00.000Z'};

function queryState(overrides: Partial<BrowserSessionQueryState> = {}): BrowserSessionQueryState {
    return {
        data: undefined,
        isPending: false,
        isError: false,
        fetchStatus: 'idle',
        ...overrides,
    };
}

describe('DashboardAccountProvider cookie session memory', () => {
    test('provider가 개인 식별정보 없이 메모리 evidence 전이를 실제 상태 계산에 연결한다', () => {
        expect(providerSource).toContain('useState<CookieSessionEvidence | null>(null)');
        expect(providerSource).toMatch(
            /transitionCookieSessionAccess\([\s\S]*cookieSessionEvidence,[\s\S]*browserSessionObservation\(browserSessionQuery\)/u,
        );
        expect(providerSource).toContain('setCookieSessionEvidence(nextCookieSessionEvidence)');
        expect(providerSource).toMatch(
            /browserSessionTransition\?\.state\s*\?\?\s*personalAccessState/u,
        );
        expect(providerSource).toContain('clock = Date.now');
        expect(providerSource).toContain(
            'useSessionExpiryClock(browserSessionQuery.data?.expiresAt, clock)',
        );
        expect(providerSource).toMatch(
            /Math\.max\(\s*currentTime,\s*browserSessionQuery\.dataUpdatedAt \?\? 0,\s*browserSessionQuery\.errorUpdatedAt \?\? 0/u,
        );
        expect(providerSource).toContain('window.setTimeout(() => setCurrentTime(clock()), delay)');
        expect(providerSource).not.toMatch(
            /\b(?:token|userId|userIdentifier|cookieValue)\b\s*[:=]/u,
        );
    });

    test('현재 clock이 마지막 fetch보다 늦으면 refetch 없이 로컬 만료를 판정한다', () => {
        const fetchedBeforeExpiry = transitionCookieSessionAccess(
            null,
            browserSessionObservation(queryState({data: session})),
            Date.parse('2026-09-09T23:59:00.000Z'),
        );
        const expiredByCurrentTime = transitionCookieSessionAccess(
            fetchedBeforeExpiry.evidence,
            browserSessionObservation(queryState({data: session})),
            Date.parse(session.expiresAt),
        );

        expect(fetchedBeforeExpiry.state.status).toBe('connected');
        expect(expiredByCurrentTime.state).toEqual({
            status: 'unconnected',
            reason: 'expired',
            expiredAt: session.expiresAt,
        });
    });

    test('authenticated 다음 null 응답은 최초 연결이 아니라 만료 상태가 된다', () => {
        const connected = transitionCookieSessionAccess(
            null,
            browserSessionObservation(queryState({data: session})),
            Date.parse('2026-09-08T00:00:00.000Z'),
        );
        const expired = transitionCookieSessionAccess(
            connected.evidence,
            browserSessionObservation(queryState({data: null})),
            Date.parse('2026-09-10T00:00:00.000Z'),
        );

        expect(expired.state).toEqual({
            status: 'unconnected',
            reason: 'expired',
            expiredAt: session.expiresAt,
        });
    });

    test.each([
        [
            'offline',
            queryState({data: session, fetchStatus: 'paused'}),
            {status: 'error', reason: 'offline'},
        ],
        [
            'server-error',
            queryState({data: session, isError: true}),
            {status: 'error', reason: 'server-error'},
        ],
    ] as const)(
        'authenticated 다음 %s는 stale session보다 오류를 우선한다',
        (_name, query, expected) => {
            const connected = transitionCookieSessionAccess(
                null,
                browserSessionObservation(queryState({data: session})),
                Date.parse('2026-09-08T00:00:00.000Z'),
            );
            const failed = transitionCookieSessionAccess(
                connected.evidence,
                browserSessionObservation(query),
                Date.parse('2026-09-08T01:00:00.000Z'),
            );

            expect(failed.state).toMatchObject(expected);
            expect(failed.evidence).toBe(connected.evidence);
        },
    );
});
