import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {dashboardRuntimeFromSignals} from './dashboard-runtime';

test('Tauri와 실제 standalone 표시 모드만 앱 표면 신호로 사용한다', () => {
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: true,
        standaloneDisplayMode: false,
        iosStandalone: false,
    }), {runningInTauri: true, standalone: false});
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: false,
        standaloneDisplayMode: true,
        iosStandalone: false,
    }), {runningInTauri: false, standalone: true});
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: false,
        standaloneDisplayMode: false,
        iosStandalone: true,
    }), {runningInTauri: false, standalone: true});
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: false,
        standaloneDisplayMode: false,
        iosStandalone: false,
    }), {runningInTauri: false, standalone: false});
});

test('실행 표면 판정은 URL 경로를 사용하지 않는다', () => {
    const source = readFileSync(new URL('./dashboard-runtime.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /location|pathname|\/app\b|\/pair\b/);
});
