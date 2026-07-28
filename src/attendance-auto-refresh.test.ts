import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformWithOxc} from 'vite';
import {test} from 'vitest';

const decisionSource = readFileSync(new URL('./injected/attendance-decision.ts', import.meta.url), 'utf8');
const injectionSource = readFileSync(new URL('./injected/attendance.ts', import.meta.url), 'utf8');

interface ClickEvidence {
    trusted: boolean;
    origin: string;
    pathname: string;
    clickedLabel: string;
    clickedDisabled: boolean;
    exactCandidateCount: number;
    clickedIsExactCandidate: boolean;
}

interface DecisionModule {
    normalizeAttendanceLabel(value: string | null): string;
    serializeLmsSelectedCohortId(cohortId: string | null): string | null;
    isSerializedLmsSelectedCohortId(value: string): boolean;
    shouldReportAttendanceStartClick(evidence: ClickEvidence): boolean;
}

async function loadDecisionModule(): Promise<DecisionModule> {
    const transformed = await transformWithOxc(decisionSource, 'attendance-decision.ts', {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
        sourcemap: false,
    });
    const context = vm.createContext({});
    new vm.Script(
        `${transformed.code}\nglobalThis.__attendanceDecision = {
            normalizeAttendanceLabel,
            serializeLmsSelectedCohortId,
            isSerializedLmsSelectedCohortId,
            shouldReportAttendanceStartClick,
        };`,
    ).runInContext(context);
    return (context as {__attendanceDecision: DecisionModule}).__attendanceDecision;
}

async function observedCommands(
    labels: string[],
    clickedIndex: number,
    options: {trusted?: boolean; origin?: string; pathname?: string} = {},
): Promise<string[]> {
    const transformed = await transformWithOxc(`${decisionSource}\n${injectionSource}`, 'attendance-injection.ts', {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
        sourcemap: false,
    });
    const context = vm.createContext({});
    new vm.Script(`
        globalThis.Element = class {
            constructor(button = null) {
                this.button = button;
            }
            closest(selector) {
                return selector === 'button' ? this.button : null;
            }
        };
        globalThis.HTMLButtonElement = class extends Element {
            constructor(textContent) {
                super();
                this.button = this;
                this.textContent = textContent;
                this.disabled = false;
            }
            getAttribute() {
                return null;
            }
        };
        globalThis.__commands = [];
        globalThis.__buttons = [];
        globalThis.document = {
            querySelectorAll() {
                return globalThis.__buttons;
            },
            addEventListener(type, handler, capture) {
                if (type === 'click') {
                    globalThis.__clickHandler = handler;
                    globalThis.__clickCapture = capture;
                }
            },
        };
        globalThis.window = {
            location: {
                origin: ${JSON.stringify(options.origin ?? 'https://jungle-lms.krafton.com')},
                pathname: ${JSON.stringify(options.pathname ?? '/check-in')},
                href: ${JSON.stringify(
                    `${options.origin ?? 'https://jungle-lms.krafton.com'}${options.pathname ?? '/check-in'}`,
                )},
            },
            __TAURI__: {
                core: {
                    invoke(command) {
                        globalThis.__commands.push(command);
                        return Promise.resolve();
                    },
                },
            },
        };
    `).runInContext(context);
    new vm.Script(transformed.code).runInContext(context);
    new vm.Script(`
        globalThis.__commands = [];
        globalThis.__buttons = ${JSON.stringify(labels)}.map((label) => new HTMLButtonElement(label));
        globalThis.__clickHandler({
            isTrusted: ${JSON.stringify(options.trusted ?? true)},
            target: new Element(globalThis.__buttons[${clickedIndex}]),
        });
    `).runInContext(context);
    assert.equal((context as {__clickCapture: boolean}).__clickCapture, true);
    return [...(context as {__commands: string[]}).__commands];
}

async function observedCohortStorageSync(
    initialValue: string | null,
    cohortId: string | null,
): Promise<{storedValue: string | null; reloads: number}> {
    const transformed = await transformWithOxc(`${decisionSource}\n${injectionSource}`, 'attendance-injection.ts', {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
        sourcemap: false,
    });
    const syncState = {storedValue: initialValue, reloads: 0};
    const context = vm.createContext({
        document: {
            addEventListener() {},
        },
        window: {
            location: {
                origin: 'https://jungle-lms.krafton.com',
                pathname: '/check-in',
                href: 'https://jungle-lms.krafton.com/check-in',
                reload() {
                    syncState.reloads += 1;
                },
            },
            localStorage: {
                getItem() {
                    return syncState.storedValue;
                },
                removeItem() {
                    syncState.storedValue = null;
                },
                setItem(_key: string, value: string) {
                    syncState.storedValue = value;
                },
            },
            __TAURI__: {
                core: {
                    invoke(command: string) {
                        return Promise.resolve(command === 'get_attendance_cohort_id' ? cohortId : undefined);
                    },
                },
            },
        },
    });

    new vm.Script(transformed.code).runInContext(context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return syncState;
}

test('공백을 정규화한 정확한 학습 시작 버튼 한 개만 허용한다', async () => {
    const decision = await loadDecisionModule();
    const evidence: ClickEvidence = {
        trusted: true,
        origin: 'https://jungle-lms.krafton.com',
        pathname: '/check-in',
        clickedLabel: decision.normalizeAttendanceLabel('  학습\n  시작  '),
        clickedDisabled: false,
        exactCandidateCount: 1,
        clickedIsExactCandidate: true,
    };

    assert.equal(evidence.clickedLabel, '학습 시작');
    assert.equal(decision.shouldReportAttendanceStartClick(evidence), true);
});

test('LMS 기수 ID는 JSON 문자열로 저장하고 손상된 원시 값은 거부한다', async () => {
    const decision = await loadDecisionModule();

    assert.equal(decision.serializeLmsSelectedCohortId('cohort-1'), '"cohort-1"');
    assert.equal(decision.serializeLmsSelectedCohortId(null), null);
    assert.equal(decision.isSerializedLmsSelectedCohortId('"cohort-1"'), true);
    assert.equal(decision.isSerializedLmsSelectedCohortId('cohort-1'), false);
    assert.equal(decision.isSerializedLmsSelectedCohortId('null'), false);
    assert.equal(decision.isSerializedLmsSelectedCohortId('{"id":"cohort-1"}'), false);
});

test('손상된 LMS 기수 값은 페이지 초기화 중 복구하고 정상 값은 다시 로드하지 않는다', async () => {
    assert.deepEqual(
        await observedCohortStorageSync('cohort-1', 'cohort-1'),
        {storedValue: '"cohort-1"', reloads: 1},
    );
    assert.deepEqual(
        await observedCohortStorageSync('"cohort-1"', 'cohort-1'),
        {storedValue: '"cohort-1"', reloads: 0},
    );
    assert.deepEqual(
        await observedCohortStorageSync('{"id":"cohort-1"}', null),
        {storedValue: null, reloads: 0},
    );
});

test('출처·경로·문구·후보 수가 조금이라도 다르면 동작하지 않는다', async () => {
    const decision = await loadDecisionModule();
    const valid: ClickEvidence = {
        trusted: true,
        origin: 'https://jungle-lms.krafton.com',
        pathname: '/check-in',
        clickedLabel: '학습 시작',
        clickedDisabled: false,
        exactCandidateCount: 1,
        clickedIsExactCandidate: true,
    };
    const invalidCases: ClickEvidence[] = [
        {...valid, trusted: false},
        {...valid, origin: 'https://example.com'},
        {...valid, pathname: '/check-in/history'},
        {...valid, clickedLabel: '학습 시작하기'},
        {...valid, clickedDisabled: true},
        {...valid, exactCandidateCount: 0},
        {...valid, exactCandidateCount: 2},
        {...valid, clickedIsExactCandidate: false},
    ];

    for (const evidence of invalidCases) {
        assert.equal(decision.shouldReportAttendanceStartClick(evidence), false);
    }
});

test('실제 DOM 연결에서도 정확한 단일 버튼을 누른 경우에만 Rust에 보고한다', async () => {
    assert.deepEqual(
        await observedCommands(['학습 시작', '학습 종료'], 0),
        ['report_attendance_start_clicked'],
    );
    assert.deepEqual(await observedCommands(['학습 시작', '학습 시작'], 0), []);
    assert.deepEqual(await observedCommands(['학습 시작', '학습 종료'], 1), []);
    assert.deepEqual(await observedCommands(['학습 시작'], 0, {trusted: false}), []);
    assert.deepEqual(await observedCommands(['학습 시작'], 0, {pathname: '/check-in/history'}), []);
});

test('학습 시작 클릭 처리는 직접 클릭하거나 새로고침하지 않는다', () => {
    const handlerStart = injectionSource.indexOf('function handleAttendanceClick');
    const handlerEnd = injectionSource.indexOf(
        "document.addEventListener('click', handleAttendanceClick",
        handlerStart,
    );
    const clickHandler = injectionSource.slice(handlerStart, handlerEnd);

    assert.ok(handlerStart >= 0);
    assert.ok(handlerEnd > handlerStart);
    assert.match(clickHandler, /event\.isTrusted/);
    assert.match(clickHandler, /\.closest\(['"]button['"]\)/);
    assert.match(clickHandler, /querySelectorAll<HTMLButtonElement>\(['"]button['"]\)/);
    assert.match(injectionSource, /addEventListener\(['"]click['"],\s*handleAttendanceClick,\s*true\)/);
    assert.doesNotMatch(clickHandler, /location\.reload|\.click\(\)/);
});
