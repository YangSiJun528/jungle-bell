import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {dashboardRuntimeFromSignals} from './runtime';

test('Tauri 런타임 유무만 플랫폼 어댑터 선택 신호로 사용한다', () => {
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: true,
    }), {runningInTauri: true});
    assert.deepEqual(dashboardRuntimeFromSignals({
        hasTauriInternals: false,
    }), {runningInTauri: false});
});

test('실행 표면 판정은 URL 경로를 사용하지 않는다', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /location|pathname|\/app\b|\/pair\b/);
});
