import {createMemoryHistory} from '@tanstack/react-router';
import {describe, expect, test} from 'vitest';

import {createDashboardRouter} from './dashboard-router';
import {normalizeLegacyDashboardHash} from './routes';

describe('dashboard router', () => {
    test('uses the typed dashboard route tree for SPA navigation', async () => {
        const history = createMemoryHistory({initialEntries: ['/home']});
        const router = createDashboardRouter(history);

        await router.load();
        await router.navigate({to: '/laundry'});

        expect(router.state.location.pathname).toBe('/laundry');
        expect(router.state.matches.at(-1)?.routeId).toBe('/laundry');
    });

    test('renders the home route when the hash path is empty', async () => {
        const history = createMemoryHistory({initialEntries: ['/']});
        const router = createDashboardRouter(history);

        await router.load();

        expect(router.state.location.pathname).toBe('/');
        expect(router.state.matches.at(-1)?.routeId).toBe('/');
    });

    test('routes the app showcase CTA to the dedicated install guide', async () => {
        const history = createMemoryHistory({initialEntries: ['/home']});
        const router = createDashboardRouter(history);

        await router.load();
        await router.navigate({to: '/install'});

        expect(router.state.location.pathname).toBe('/install');
        expect(router.state.matches.at(-1)?.routeId).toBe('/install');
    });

    test('exposes the privacy notice as a dedicated public route', async () => {
        const history = createMemoryHistory({initialEntries: ['/privacy']});
        const router = createDashboardRouter(history);

        await router.load();

        expect(router.state.matches.at(-1)?.routeId).toBe('/privacy');
    });

    test('normalizes legacy route fragments without touching pairing fragments', () => {
        expect(normalizeLegacyDashboardHash('#attendance')).toBe('#/attendance');
        expect(normalizeLegacyDashboardHash('#/attendance')).toBeNull();
        expect(normalizeLegacyDashboardHash('#pairing=secret')).toBeNull();
    });

    test('validates connections search on direct load and typed navigation', async () => {
        const history = createMemoryHistory({
            initialEntries: ['/connections?tab=devices&returnTo=%2Fattendance'],
        });
        const router = createDashboardRouter(history);

        await router.load();
        expect(router.state.matches.at(-1)?.search).toEqual({
            tab: 'devices',
            returnTo: '/attendance',
        });

        await router.navigate({to: '/connections', search: {tab: 'services'}});
        expect(router.state.matches.at(-1)?.search).toEqual({tab: 'services'});
    });

    test('normalizes invalid connections search without retaining an unsafe return target', () => {
        const history = createMemoryHistory({
            initialEntries: ['/connections?tab=invalid&returnTo=%2F%2Fevil.example%2Fcallback'],
        });
        const router = createDashboardRouter(history);
        const matches = router.matchRoutes(router.state.location);
        const strictSearch = Reflect.get(matches.at(-1) ?? {}, '_strictSearch');

        expect(strictSearch).toEqual({tab: 'notifications'});
    });

    test('restores connections tabs through browser back and forward history', async () => {
        const history = createMemoryHistory({
            initialEntries: ['/connections?tab=notifications'],
        });
        const router = createDashboardRouter(history);
        await router.load();
        await router.navigate({to: '/connections', search: {tab: 'services'}});
        await router.navigate({to: '/connections', search: {tab: 'devices'}});

        history.back();
        await router.load();
        expect(router.state.matches.at(-1)?.search).toEqual({tab: 'services'});

        history.forward();
        await router.load();
        expect(router.state.matches.at(-1)?.search).toEqual({tab: 'devices'});
    });
});
