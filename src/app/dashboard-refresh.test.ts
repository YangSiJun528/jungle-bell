import assert from 'node:assert/strict';
import {test} from 'vitest';
import {runAttendanceRefresh, runDashboardRefresh} from './dashboard-refresh';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

test('desktop refresh starts campus and platform work together, then refreshes dependent personal data', async () => {
    const laundry = deferred();
    const meals = deferred();
    const platform = deferred();
    const attendance = deferred();
    const overview = deferred();
    const starts: string[] = [];

    const refresh = runDashboardRefresh({
        refreshLaundry: () => { starts.push('laundry'); return laundry.promise; },
        refreshMeals: () => { starts.push('meals'); return meals.promise; },
        refreshPlatform: () => { starts.push('platform'); return platform.promise; },
        refreshAttendance: () => { starts.push('attendance'); return attendance.promise; },
        refreshHomeOverview: () => { starts.push('overview'); return overview.promise; },
    });

    assert.deepEqual(starts, ['laundry', 'meals', 'platform']);
    platform.resolve();
    await Promise.resolve();
    assert.deepEqual(starts, ['laundry', 'meals', 'platform', 'attendance', 'overview']);

    laundry.resolve();
    meals.resolve();
    attendance.resolve();
    overview.resolve();
    await refresh;
});

test('companion refresh starts all active queries concurrently without a desktop overview', async () => {
    const starts: string[] = [];
    await runDashboardRefresh({
        refreshLaundry: async () => { starts.push('laundry'); },
        refreshMeals: async () => { starts.push('meals'); },
        refreshAttendance: async () => { starts.push('attendance'); },
    });
    assert.deepEqual(starts, ['laundry', 'meals', 'attendance']);
});

test('refresh rejects when any task fails', async () => {
    await assert.rejects(runDashboardRefresh({
        refreshLaundry: async () => { throw new Error('LAUNDRY_FAILED'); },
        refreshMeals: async () => undefined,
    }), /LAUNDRY_FAILED/);
});

test('desktop attendance refresh syncs the checker before refetching dependent queries', async () => {
    const platform = deferred();
    const starts: string[] = [];
    const refresh = runAttendanceRefresh({
        refreshPlatform: () => { starts.push('platform'); return platform.promise; },
        refreshAttendance: async () => { starts.push('attendance'); },
        refreshHomeOverview: async () => { starts.push('overview'); },
    });

    assert.deepEqual(starts, ['platform']);
    platform.resolve();
    await refresh;
    assert.deepEqual(starts, ['platform', 'attendance', 'overview']);
});

test('companion attendance refresh refetches without a desktop checker sync', async () => {
    const starts: string[] = [];
    await runAttendanceRefresh({
        refreshAttendance: async () => { starts.push('attendance'); },
    });
    assert.deepEqual(starts, ['attendance']);
});
