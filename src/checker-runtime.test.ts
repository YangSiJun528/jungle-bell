import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformWithOxc} from 'vite';
import {test} from 'vitest';

const source = readFileSync(new URL('./injected/checker.ts', import.meta.url), 'utf8');

interface InvokeCall {
    command: string;
    event: Record<string, unknown>;
}

async function executeChecker(options: {invalidSelection?: boolean} = {}) {
    const transformed = await transformWithOxc(source, 'checker.ts', {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
    });
    const calls: InvokeCall[] = [];
    let trigger: ((event: {payload: unknown}) => void) | null = null;
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        const event = args?.event as Record<string, unknown>;
        calls.push({command, event});
        if (event.type === 'resolveCohort') {
            return options.invalidSelection
                ? {type: 'cohortSelection', selection: {legacy: true}}
                : {
                    type: 'cohortSelection',
                    selection: {
                        cohort_id: 'cohort-1',
                        cohort_status: 'active',
                        cohort_start_date: '2026-01-01',
                        cohort_end_date: '2026-12-31',
                    },
                };
        }
        return {type: 'acknowledged'};
    };
    const context = vm.createContext({
        Date,
        Number,
        Object,
        Promise,
        String,
        console,
        fetch: async (url: string) => url.endsWith('/api/v2/me/cohorts')
            ? {
                status: 200,
                statusText: 'OK',
                ok: true,
                json: async () => [{
                    id: 'cohort-1', name: '1기', startDate: '2026-01-01',
                    endDate: '2026-12-31', isActive: true,
                }],
            }
            : {
                status: 200,
                statusText: 'OK',
                ok: true,
                text: async () => JSON.stringify({checkedAt: '2026-08-10T09:00:00+09:00', checkedOutAt: null}),
            },
        window: {
            location: {href: 'https://jungle-lms.krafton.com/check-in'},
            __TAURI__: {
                core: {invoke},
                event: {
                    listen: async (_event: string, handler: (event: {payload: unknown}) => void) => {
                        trigger = handler;
                        return () => undefined;
                    },
                },
            },
        },
    });
    vm.runInContext(transformed.code, context);
    await flushTasks();
    return {
        calls,
        trigger(payload: unknown) {
            assert.ok(trigger);
            trigger({payload});
        },
    };
}

async function flushTasks(): Promise<void> {
    for (let count = 0; count < 8; count += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function localValue<T>(value: unknown): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

test('checker는 positive trigger 뒤 단일 tagged IPC로 ready·resolve·snapshot을 보고한다', async () => {
    const runtime = await executeChecker();
    assert.deepEqual(runtime.calls.map(({command}) => command), ['report_checker_event']);
    assert.deepEqual(runtime.calls.map(({event}) => event.type), ['log']);

    runtime.trigger({generation: 3});
    await flushTasks();

    assert.ok(runtime.calls.every(({command}) => command === 'report_checker_event'));
    const eventTypes = runtime.calls.map(({event}) => event.type);
    assert.equal(eventTypes[0], 'log');
    assert.ok(eventTypes.indexOf('ready') < eventTypes.indexOf('resolveCohort'));
    assert.ok(eventTypes.indexOf('resolveCohort') < eventTypes.indexOf('attendanceSnapshot'));
    const ready = runtime.calls.find(({event}) => event.type === 'ready')?.event;
    assert.deepEqual(localValue(ready), {type: 'ready', generation: 3});
    const snapshot = runtime.calls.find(({event}) => event.type === 'attendanceSnapshot')?.event.status;
    assert.deepEqual(localValue(snapshot), {
        generation: 3,
        needs_login: false,
        morning_done: true,
        evening_done: false,
        api_error: false,
        cohort_status: 'active',
        cohort_start_date: '2026-01-01',
        cohort_end_date: '2026-12-31',
    });
});

test('checker는 잘못된 generation을 거부하고 strict cohort 응답 오류를 api_error snapshot으로 제한한다', async () => {
    const runtime = await executeChecker({invalidSelection: true});
    runtime.trigger({generation: 0});
    await flushTasks();
    assert.equal(runtime.calls.some(({event}) => event.type === 'ready'), false);

    runtime.trigger({generation: 1});
    await flushTasks();
    const snapshot = runtime.calls.find(({event}) => event.type === 'attendanceSnapshot')?.event.status;
    assert.deepEqual(localValue(snapshot), {
        generation: 1,
        needs_login: false,
        morning_done: false,
        evening_done: false,
        api_error: true,
        cohort_status: 'unknown',
        cohort_start_date: null,
        cohort_end_date: null,
    });
});

test('검사 중 새 generation trigger가 오면 최신 검사를 유실하지 않는다', async () => {
    const runtime = await executeChecker();
    runtime.trigger({generation: 1});
    runtime.trigger({generation: 2});
    await flushTasks();

    const generations = runtime.calls
        .filter(({event}) => event.type === 'attendanceSnapshot')
        .map(({event}) => (event.status as {generation: number}).generation);
    assert.deepEqual(generations, [1, 2]);
});
