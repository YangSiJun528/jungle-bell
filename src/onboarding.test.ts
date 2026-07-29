import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    alpineData: vi.fn(),
    alpineNextTick: vi.fn(),
    alpineStart: vi.fn(),
    close: vi.fn(),
    connectSettingsSnapshots: vi.fn(),
    invoke: vi.fn(),
    invokeSettingsMutation: vi.fn(),
    listen: vi.fn(),
    message: vi.fn(),
    refreshSettingsSnapshot: vi.fn(),
}));

vi.mock('alpinejs', () => ({
    default: {
        data: mocks.alpineData,
        nextTick: mocks.alpineNextTick,
        start: mocks.alpineStart,
    },
}));
vi.mock('./select-control', () => ({}));
vi.mock('@tauri-apps/api/core', () => ({invoke: mocks.invoke}));
vi.mock('@tauri-apps/api/event', () => ({listen: mocks.listen}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({close: mocks.close}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({message: mocks.message}));
vi.mock('./settings-state', () => ({
    connectSettingsSnapshots: mocks.connectSettingsSnapshots,
    invokeSettingsMutation: mocks.invokeSettingsMutation,
    refreshSettingsSnapshot: mocks.refreshSettingsSnapshot,
}));

interface OnboardingHarness {
    step: number;
    totalSteps: number;
    onboardingCompleted: boolean;
    completionPending: boolean;
    completionFailed: boolean;
    readonly finalActionDisabled: boolean;
    readonly nextLabel: string;
    readonly finalDescription: string;
    enterStep(nextStep: number): void;
    next(): Promise<void>;
    previous(): void;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, reject, resolve};
}

let createOnboarding: () => OnboardingHarness;

beforeAll(async () => {
    vi.stubGlobal('navigator', {userAgent: 'Macintosh'});
    vi.stubGlobal('window', {
        clearInterval: vi.fn(),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        }),
        setInterval: vi.fn(() => 1),
        setTimeout: vi.fn((callback: TimerHandler) => {
            if (typeof callback === 'function') callback();
            return 1;
        }),
    });

    await import('./onboarding');
    const registration = mocks.alpineData.mock.calls
        .find(([name]) => name === 'onboarding');
    expect(registration).toBeDefined();
    createOnboarding = registration?.[1] as () => OnboardingHarness;
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('온보딩 최종 CTA', () => {
    test('마지막 단계에 진입하는 것만으로 완료를 저장하거나 창을 닫지 않는다', async () => {
        const component = createOnboarding();

        component.enterStep(component.totalSteps - 1);
        await Promise.resolve();

        expect(component.step).toBe(3);
        expect(component.nextLabel).toBe('시작하기');
        expect(component.finalActionDisabled).toBe(false);
        expect(mocks.invoke).not.toHaveBeenCalledWith('complete_onboarding');
        expect(mocks.close).not.toHaveBeenCalled();
    });

    test('시작하기를 누르면 완료를 저장한 뒤 창을 닫는다', async () => {
        const component = createOnboarding();
        component.step = component.totalSteps - 1;
        mocks.invoke.mockResolvedValue(undefined);
        mocks.close.mockResolvedValue(undefined);

        await component.next();

        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.invoke).toHaveBeenCalledWith('complete_onboarding');
        expect(mocks.close).toHaveBeenCalledTimes(1);
        expect(mocks.invoke.mock.invocationCallOrder[0]!).toBeLessThan(
            mocks.close.mock.invocationCallOrder[0]!,
        );
        expect(component.onboardingCompleted).toBe(true);
        expect(component.completionPending).toBe(false);
        expect(component.completionFailed).toBe(false);
    });

    test('저장 실패를 표시하고 같은 CTA로 재시도할 수 있다', async () => {
        const component = createOnboarding();
        component.step = component.totalSteps - 1;
        mocks.invoke
            .mockRejectedValueOnce(new Error('save failed'))
            .mockResolvedValueOnce(undefined);
        mocks.close.mockResolvedValue(undefined);

        await component.next();

        expect(component.completionFailed).toBe(true);
        expect(component.nextLabel).toBe('다시 시도');
        expect(component.finalDescription).toContain('완료 저장에 실패');
        expect(mocks.close).not.toHaveBeenCalled();

        await component.next();

        expect(mocks.invoke).toHaveBeenCalledTimes(2);
        expect(mocks.close).toHaveBeenCalledTimes(1);
        expect(component.completionFailed).toBe(false);
    });

    test('처리 중인 연속 클릭은 완료 저장을 중복 호출하지 않는다', async () => {
        const component = createOnboarding();
        component.step = component.totalSteps - 1;
        const completion = deferred<void>();
        mocks.invoke.mockReturnValue(completion.promise);
        mocks.close.mockResolvedValue(undefined);

        const first = component.next();
        const second = component.next();

        expect(component.completionPending).toBe(true);
        expect(component.finalActionDisabled).toBe(true);
        expect(component.nextLabel).toBe('시작하는 중');
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.close).not.toHaveBeenCalled();

        component.previous();
        expect(component.step).toBe(component.totalSteps - 1);

        completion.resolve();
        await Promise.all([first, second]);

        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    test('완료 저장 후 창 닫기만 실패하면 저장을 반복하지 않고 닫기만 재시도한다', async () => {
        const component = createOnboarding();
        component.step = component.totalSteps - 1;
        mocks.invoke.mockResolvedValue(undefined);
        mocks.close
            .mockRejectedValueOnce(new Error('close failed'))
            .mockResolvedValueOnce(undefined);

        await component.next();

        expect(component.onboardingCompleted).toBe(true);
        expect(component.completionFailed).toBe(true);
        expect(component.finalDescription).toContain('창을 닫지 못했어요');

        await component.next();

        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.close).toHaveBeenCalledTimes(2);
    });
});
