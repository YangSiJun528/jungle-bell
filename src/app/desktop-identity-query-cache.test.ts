import {QueryClient} from '@tanstack/react-query';
import {expect, test} from 'vitest';
import {queryKeys, removeDesktopIdentityQueries} from './dashboard-context';

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

test('identity reset clears personal cache before the native reset starts', () => {
    const source = readFileSync(
        new URL('../features/connections/connections-page.tsx', import.meta.url),
        'utf8',
    );
    const resetMutation = source.slice(source.indexOf('const reset = useMutation'));
    expect(resetMutation.indexOf('onMutate:')).toBeGreaterThanOrEqual(0);
    expect(resetMutation.indexOf('removeDesktopIdentityQueries(client)'))
        .toBeGreaterThan(resetMutation.indexOf('onMutate:'));
    expect(resetMutation.indexOf('removeDesktopIdentityQueries(client)'))
        .toBeLessThan(resetMutation.indexOf('onSuccess:'));
});
import {readFileSync} from 'node:fs';
