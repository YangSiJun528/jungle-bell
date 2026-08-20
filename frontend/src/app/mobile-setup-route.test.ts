import {createMemoryHistory} from '@tanstack/react-router';
import {describe, expect, test} from 'vitest';
import {createDashboardRouter} from './dashboard-router';

describe('mobile setup route', () => {
    test('QR 진입을 독립된 휴대폰 설정 경로로 연다', async () => {
        const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/setup']}));

        await router.load();

        expect(router.state.matches.at(-1)?.routeId).toBe('/setup');
    });
});
