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
});
