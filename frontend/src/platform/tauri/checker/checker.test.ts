import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {transformWithOxc} from 'vite';
import {test} from 'vitest';

const source = readFileSync(new URL('./checker.ts', import.meta.url), 'utf8');

interface InvokeCall {
    command: string;
    event: Record<string, unknown>;
}

interface StylesheetFixture {
    href: string;
    loaded: boolean;
}

interface MockStylesheetLink {
    addEventListener(event: string, handler: () => void, options?: {once?: boolean}): void;
    dataset: Record<string, string>;
    dispatch(event: string): void;
    href: string;
    sheet: object | null;
}

async function executeChecker(
    options: {
        invalidSelection?: boolean;
        locationHref?: string;
        stylesheets?: StylesheetFixture[];
    } = {},
) {
    const transformed = await transformWithOxc(source, 'checker.ts', {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
    });
    const calls: InvokeCall[] = [];
    const eventListeners = new Map<string, (event: {payload: unknown}) => void>();
    let now = Date.now();
    let windowLoad: (() => void) | null = null;
    let replacedLocation: string | null = null;
    class TestDate extends Date {
        static override now(): number {
            return now;
        }
    }
    const lmsLocation = new URL(options.locationHref ?? 'https://jungle-lms.krafton.com/check-in');
    const stylesheetLinks: MockStylesheetLink[] = (options.stylesheets ?? []).map(
        ({href, loaded}) => {
            const listeners = new Map<string, {handler: () => void; once: boolean}>();
            return {
                addEventListener(event, handler, listenerOptions) {
                    listeners.set(event, {handler, once: listenerOptions?.once === true});
                },
                dispatch(event) {
                    const listener = listeners.get(event);
                    listener?.handler();
                    if (listener?.once) listeners.delete(event);
                },
                dataset: {},
                href,
                sheet: loaded ? {} : null,
            };
        },
    );
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
        Date: TestDate,
        Number,
        Object,
        Promise,
        String,
        console,
        fetch: async (url: string) =>
            url.endsWith('/api/v2/me/cohorts')
                ? {
                      status: 200,
                      statusText: 'OK',
                      ok: true,
                      json: async () => [
                          {
                              id: 'cohort-1',
                              name: '1기',
                              startDate: '2026-01-01',
                              endDate: '2026-12-31',
                              isActive: true,
                          },
                      ],
                  }
                : {
                      status: 200,
                      statusText: 'OK',
                      ok: true,
                      text: async () =>
                          JSON.stringify({
                              checkedAt: '2026-08-10T09:00:00+09:00',
                              checkedOutAt: null,
                          }),
                  },
        window: {
            location: {
                href: lmsLocation.href,
                origin: lmsLocation.origin,
                replace(href: string) {
                    replacedLocation = href;
                },
            },
            __TAURI__: {
                core: {invoke},
                event: {
                    listen: async (event: string, handler: (event: {payload: unknown}) => void) => {
                        eventListeners.set(event, handler);
                        return () => undefined;
                    },
                },
            },
            addEventListener(event: string, handler: () => void) {
                if (event === 'load') windowLoad = handler;
            },
        },
        document: {
            querySelectorAll(selector: string) {
                assert.equal(selector, 'link[rel~="stylesheet"][href]');
                return stylesheetLinks;
            },
        },
        URL,
    });
    vm.runInContext(transformed.code, context);
    await flushTasks();
    return {
        calls,
        trigger(payload: unknown) {
            const trigger = eventListeners.get('trigger-check');
            assert.ok(trigger);
            trigger({payload});
        },
        prepareWindow() {
            const prepare = eventListeners.get('prepare-lms-window');
            assert.ok(prepare);
            prepare({payload: null});
        },
        dispatchWindowLoad() {
            assert.ok(windowLoad);
            windowLoad();
        },
        stylesheetHrefs() {
            return stylesheetLinks.map(({href}) => href);
        },
        failStylesheet(index = 0) {
            stylesheetLinks[index]?.dispatch('error');
        },
        replacedLocation() {
            return replacedLocation;
        },
        advanceTime(milliseconds: number) {
            now += milliseconds;
        },
    };
}

async function flushTasks(): Promise<void> {
    for (let count = 0; count < 8; count += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function localValue(value: unknown): unknown {
    return structuredClone(value);
}

test('checker는 positive trigger 뒤 단일 tagged IPC로 ready·resolve·snapshot을 보고한다', async () => {
    const runtime = await executeChecker();
    assert.deepEqual(
        runtime.calls.map(({command}) => command),
        ['report_checker_event'],
    );
    assert.deepEqual(
        runtime.calls.map(({event}) => event.type),
        ['log'],
    );

    runtime.trigger({generation: 3});
    await flushTasks();

    assert.ok(runtime.calls.every(({command}) => command === 'report_checker_event'));
    const eventTypes = runtime.calls.map(({event}) => event.type);
    assert.equal(eventTypes[0], 'log');
    assert.ok(eventTypes.indexOf('ready') < eventTypes.indexOf('resolveCohort'));
    assert.ok(eventTypes.indexOf('resolveCohort') < eventTypes.indexOf('attendanceSnapshot'));
    const ready = runtime.calls.find(({event}) => event.type === 'ready')?.event;
    assert.deepEqual(localValue(ready), {type: 'ready', generation: 3});
    const snapshot = runtime.calls.find(({event}) => event.type === 'attendanceSnapshot')?.event
        .status;
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
    assert.equal(
        runtime.calls.some(({event}) => event.type === 'ready'),
        false,
    );

    runtime.trigger({generation: 1});
    await flushTasks();
    const snapshot = runtime.calls.find(({event}) => event.type === 'attendanceSnapshot')?.event
        .status;
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

test('정상적으로 적용된 LMS 스타일시트는 수정하지 않는다', async () => {
    const href = 'https://jungle-lms.krafton.com/_next/static/css/934f429988e2d2ad.css';
    const runtime = await executeChecker({stylesheets: [{href, loaded: true}]});

    runtime.dispatchWindowLoad();
    runtime.prepareWindow();

    assert.deepEqual(runtime.stylesheetHrefs(), [href]);
});

test('로드에 실패한 LMS Next CSS는 캐시를 우회해 다시 요청한다', async () => {
    const href = 'https://jungle-lms.krafton.com/_next/static/css/934f429988e2d2ad.css';
    const runtime = await executeChecker({stylesheets: [{href, loaded: false}]});

    runtime.dispatchWindowLoad();

    const [retriedHref] = runtime.stylesheetHrefs();
    const retriedUrl = new URL(retriedHref ?? '');
    assert.equal(retriedUrl.origin, 'https://jungle-lms.krafton.com');
    assert.equal(retriedUrl.pathname, '/_next/static/css/934f429988e2d2ad.css');
    assert.match(retriedUrl.searchParams.get('jungle-bell-retry') ?? '', /^\d+$/u);

    runtime.prepareWindow();
    assert.equal(runtime.stylesheetHrefs()[0], retriedHref);

    runtime.advanceTime(10_001);
    runtime.prepareWindow();
    assert.notEqual(runtime.stylesheetHrefs()[0], retriedHref);
});

test('LMS와 관계없는 스타일시트 URL은 캐시 복구 대상에서 제외한다', async () => {
    const unrelatedHref = 'https://example.com/_next/static/css/untrusted.css';
    const nonNextHref = 'https://jungle-lms.krafton.com/assets/site.css';
    const runtime = await executeChecker({
        stylesheets: [
            {href: unrelatedHref, loaded: false},
            {href: nonNextHref, loaded: false},
        ],
    });

    runtime.dispatchWindowLoad();

    assert.deepEqual(runtime.stylesheetHrefs(), [unrelatedHref, nonNextHref]);
});

test('Google 로그인 화면에서는 LMS CSS 복구를 시도하지 않는다', async () => {
    const href = 'https://jungle-lms.krafton.com/_next/static/css/934f429988e2d2ad.css';
    const runtime = await executeChecker({
        locationHref: 'https://accounts.google.com/o/oauth2/auth',
        stylesheets: [{href, loaded: false}],
    });

    runtime.dispatchWindowLoad();

    assert.deepEqual(runtime.stylesheetHrefs(), [href]);
    assert.equal(runtime.replacedLocation(), null);
});

test('CSS 캐시 우회도 실패하면 LMS 문서를 한 번만 새로 받는다', async () => {
    const href = 'https://jungle-lms.krafton.com/_next/static/css/obsolete.css';
    const runtime = await executeChecker({stylesheets: [{href, loaded: false}]});

    runtime.dispatchWindowLoad();
    runtime.failStylesheet();

    const replacedHref = runtime.replacedLocation();
    assert.ok(replacedHref);
    const replacedUrl = new URL(replacedHref);
    assert.equal(replacedUrl.origin, 'https://jungle-lms.krafton.com');
    assert.equal(replacedUrl.pathname, '/check-in');
    assert.match(replacedUrl.searchParams.get('jungle-bell-document-retry') ?? '', /^\d+$/u);
});

test('문서 캐시 우회 후에도 CSS가 실패하면 재로드 루프를 만들지 않는다', async () => {
    const href = 'https://jungle-lms.krafton.com/_next/static/css/obsolete.css';
    const runtime = await executeChecker({
        locationHref: 'https://jungle-lms.krafton.com/check-in?jungle-bell-document-retry=123',
        stylesheets: [{href, loaded: false}],
    });

    runtime.dispatchWindowLoad();
    runtime.failStylesheet();

    assert.equal(runtime.replacedLocation(), null);
});
