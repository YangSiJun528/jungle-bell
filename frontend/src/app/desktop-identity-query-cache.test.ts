import {QueryClient} from '@tanstack/react-query';
import {expect, test} from 'vitest';

import {
    queryKeys,
    refreshBrowserPersonalQueries,
    removeBrowserPersonalQueries,
    removeDesktopIdentityQueries,
} from './dashboard-context';

test('identity reset removes all old personal, pairing, inbox, and session query data', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendance('desktop'), {private: true});
    client.setQueryData(queryKeys.desktopConnection, {state: 'connected'});
    client.setQueryData(queryKeys.attendance('browser'), {companion: true});
    client.setQueryData(queryKeys.notifications('desktop'), {private: true});
    client.setQueryData(queryKeys.mobileSessions, [{private: true}]);
    client.setQueryData(['personal', 'laundry-watches'], [{private: true}]);
    client.setQueryData(['pairing-status', 'jbp_old'], {confirmationCode: 'ABCD'});
    client.setQueryData(queryKeys.laundry, {public: true});

    removeDesktopIdentityQueries(client);

    expect(client.getQueryData(queryKeys.attendance('desktop'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.desktopConnection)).toBeUndefined();
    expect(client.getQueryData(queryKeys.notifications('desktop'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.mobileSessions)).toBeUndefined();
    expect(client.getQueryData(['personal', 'laundry-watches'])).toBeUndefined();
    expect(client.getQueryData(['pairing-status', 'jbp_old'])).toBeUndefined();
    expect(client.getQueryData(queryKeys.attendance('browser'))).toEqual({companion: true});
    expect(client.getQueryData(queryKeys.laundry)).toEqual({public: true});
});

test('브라우저 연결 해제는 개인 캐시를 즉시 제거하고 세션을 미연결로 전환한다', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.accountSession, {authenticated: true});
    client.setQueryData(queryKeys.attendance('browser'), {private: true});
    client.setQueryData(queryKeys.notifications('browser'), [{private: true}]);
    client.setQueryData(queryKeys.attendancePreferences, {private: true});
    client.setQueryData(queryKeys.mealPreferences, {private: true});
    client.setQueryData(queryKeys.laundryWatches, [{private: true}]);
    client.setQueryData(queryKeys.laundry, {public: true});

    removeBrowserPersonalQueries(client);

    expect(client.getQueryData(queryKeys.accountSession)).toBeNull();
    expect(client.getQueryData(queryKeys.attendance('browser'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.notifications('browser'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.attendancePreferences)).toBeUndefined();
    expect(client.getQueryData(queryKeys.mealPreferences)).toBeUndefined();
    expect(client.getQueryData(queryKeys.laundryWatches)).toBeUndefined();
    expect(client.getQueryData(queryKeys.laundry)).toEqual({public: true});
});

test('pairing 완료는 계정 세션과 브라우저 개인 query를 함께 무효화한다', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.accountSession, null);
    client.setQueryData(queryKeys.attendance('browser'), {private: true});
    client.setQueryData(queryKeys.notifications('browser'), [{private: true}]);
    client.setQueryData(queryKeys.laundryWatches, [{private: true}]);

    await refreshBrowserPersonalQueries(client);

    expect(client.getQueryState(queryKeys.accountSession)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.attendance('browser'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.notifications('browser'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.laundryWatches)?.isInvalidated).toBe(true);
});

test('identity reset clears personal cache before the native reset starts', () => {
    const source = readFileSync(
        new URL('../features/connections/connections-page.tsx', import.meta.url),
        'utf8',
    );
    const resetMutation = source.slice(source.indexOf('const reset = useMutation'));
    expect(resetMutation.indexOf('onMutate:')).toBeGreaterThanOrEqual(0);
    expect(resetMutation.indexOf('removeDesktopIdentityQueries(client)')).toBeGreaterThan(
        resetMutation.indexOf('onMutate:'),
    );
    expect(resetMutation.indexOf('removeDesktopIdentityQueries(client)')).toBeLessThan(
        resetMutation.indexOf('onSuccess:'),
    );
});
import {readFileSync} from 'node:fs';
