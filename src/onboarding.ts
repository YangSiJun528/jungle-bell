import Alpine from 'alpinejs';
import './select-control';
import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {message} from '@tauri-apps/plugin-dialog';
import {
    connectSettingsSnapshots,
    invokeSettingsMutation,
    refreshSettingsSnapshot,
    type SettingsSnapshot,
} from './settings-state';

type OsName = 'mac' | 'win';
type ScenarioName = 'morning' | 'day' | 'night';
type TrayStatusIcon = 'alert' | 'normal';

interface LoginStatus {
    dataLoaded: boolean;
    needsLogin: boolean;
}

interface Scenario {
    icon: TrayStatusIcon;
    status: string;
    time: string;
    caption: Record<OsName, string[]>;
}

const TOTAL_STEPS = 6;
const LOGIN_STEP = 1;
const SCENARIO_STEP = 4;
const SCENARIO_ORDER: ScenarioName[] = ['morning', 'day', 'night'];
const TRAY_ICONS: Record<TrayStatusIcon, string> = {
    alert: new URL('./assets/tray-mini-alert.png', import.meta.url).href,
    normal: new URL('./assets/tray-mini-normal.png', import.meta.url).href,
};
const SCENARIOS: Record<ScenarioName, Scenario> = {
    morning: {
        icon: 'alert', status: '출석 시작 가능', time: '09:24',
        caption: {
            mac: ['빨간 아이콘은 출석 시작이 필요한 상태예요.', '출석 페이지를 열어 체크인해 주세요.'],
            win: ['빨간 아이콘은 출석 시작이 필요한 상태예요.', '출석 페이지를 열어 체크인해 주세요.'],
        },
    },
    day: {
        icon: 'normal', status: '학습 중', time: '14:08',
        caption: {
            mac: ['테마에 섞이는 컷아웃은 지금 필요한 조작이 없다는 뜻이에요.', '종료 가능 시각까지 별도 작업은 필요 없어요.'],
            win: ['테마에 섞이는 컷아웃은 지금 필요한 조작이 없다는 뜻이에요.', '종료 가능 시각까지 별도 작업은 필요 없어요.'],
        },
    },
    night: {
        icon: 'alert', status: '출석 종료 가능', time: '23:30',
        caption: {
            mac: ['빨간 아이콘은 출석 종료가 필요한 상태예요.', '출석 페이지를 열어 체크아웃해 주세요.'],
            win: ['빨간 아이콘은 출석 종료가 필요한 상태예요.', '출석 페이지를 열어 체크아웃해 주세요.'],
        },
    },
};

interface OnboardingComponent {
    step: number;
    totalSteps: number;
    currentOs: OsName;
    scenarioName: ScenarioName;
    loginDataLoaded: boolean;
    needsLogin: boolean;
    onboardingCompleted: boolean;
    completionPending: boolean;
    completionFailed: boolean;
    settingsRevision: number;
    lastSettingsSnapshot: SettingsSnapshot | null;
    startNotification: boolean;
    endNotification: boolean;
    notificationStart: number;
    notificationEnd: number;
    startInterval: number;
    endInterval: number;
    unlistenLogin: UnlistenFn | null;
    unlistenSettings: UnlistenFn | null;
    loginRefreshTimer: number | null;
    completionScheduled: boolean;
    get isLast(): boolean;
    get nextDisabled(): boolean;
    get nextLabel(): string;
    get finalDescription(): string;
    get scenario(): Scenario;
    get scenarioIcon(): string;
    get scenarioCaption(): string[];
    init(): Promise<void>;
    destroy(): void;
    setOs(os: OsName): void;
    setScenario(name: ScenarioName): void;
    previous(): void;
    next(): void;
    skip(): void;
    handleKey(event: KeyboardEvent): void;
    enterStep(nextStep: number, scenario?: ScenarioName): void;
    moveScenario(delta: number): boolean;
    applyLoginStatus(status: LoginStatus | boolean): void;
    syncLoginStatus(): Promise<void>;
    requestLoginRefresh(): void;
    startLoginRefresh(): void;
    stopLoginRefresh(): void;
    openAttendance(): Promise<void>;
    complete(): Promise<void>;
    scheduleComplete(): void;
    hydrateNotificationSettings(): Promise<void>;
    restoreNotificationSettings(context: string, error: unknown, fallback?: () => void): Promise<void>;
    saveToggle(command: string, field: 'startNotification' | 'endNotification'): Promise<void>;
    saveTime(command: string, hour: number): Promise<void>;
    saveInterval(command: string, value: number): Promise<void>;
    openNotificationSettings(): Promise<void>;
}

function projectNotificationSettings(
    target: OnboardingComponent,
    snapshot: SettingsSnapshot,
): void {
    target.startNotification = snapshot.startNotification;
    target.endNotification = snapshot.endNotification;
    target.notificationStart = snapshot.notificationStart.hour;
    target.notificationEnd = snapshot.notificationEnd.hour;
    target.startInterval = snapshot.startInterval;
    target.endInterval = snapshot.endInterval;
    target.lastSettingsSnapshot = snapshot;
}

function onboarding(): OnboardingComponent {
    return {
        step: 0,
        totalSteps: TOTAL_STEPS,
        currentOs: /Win/i.test(navigator.userAgent) ? 'win' : 'mac',
        scenarioName: 'morning',
        loginDataLoaded: false,
        needsLogin: true,
        onboardingCompleted: false,
        completionPending: false,
        completionFailed: false,
        settingsRevision: -1,
        lastSettingsSnapshot: null,
        startNotification: true,
        endNotification: true,
        notificationStart: 4,
        notificationEnd: 4,
        startInterval: 15,
        endInterval: 15,
        unlistenLogin: null,
        unlistenSettings: null,
        loginRefreshTimer: null,
        completionScheduled: false,

        get isLast() { return this.step === TOTAL_STEPS - 1; },
        get nextDisabled() { return this.step === LOGIN_STEP && (!this.loginDataLoaded || this.needsLogin); },
        get nextLabel() {
            if (!this.isLast) return '다음';
            if (this.onboardingCompleted) return '완료됨';
            if (this.completionFailed) return '다시 시도';
            return '완료 중';
        },
        get finalDescription() {
            if (this.onboardingCompleted) return '완료됐어요. 창을 직접 닫아주세요.';
            if (this.completionFailed) return '완료 저장에 실패했어요. 다시 시도해 주세요.';
            return '완료 처리 중이에요.';
        },
        get scenario() { return SCENARIOS[this.scenarioName]; },
        get scenarioIcon() { return TRAY_ICONS[this.scenario.icon]; },
        get scenarioCaption() { return this.scenario.caption[this.currentOs]; },

        async init() {
            try {
                this.unlistenLogin = await listen<LoginStatus>('login-status-changed', (event) => {
                    this.applyLoginStatus(event.payload);
                });
                await this.syncLoginStatus();
            } catch (error) {
                console.error('[onboarding] login initialization failed', error);
            }
            await this.hydrateNotificationSettings();
        },

        destroy() {
            this.stopLoginRefresh();
            this.unlistenLogin?.();
            this.unlistenLogin = null;
            this.unlistenSettings?.();
            this.unlistenSettings = null;
        },

        setOs(os) { this.currentOs = os; },
        setScenario(name) { this.scenarioName = name; },

        previous() {
            if (this.step === SCENARIO_STEP && this.moveScenario(-1)) return;
            if (this.step > 0) {
                const nextStep = this.step - 1;
                this.enterStep(nextStep, nextStep === SCENARIO_STEP ? 'night' : undefined);
            }
        },

        next() {
            if (this.nextDisabled) return;
            if (this.step === SCENARIO_STEP && this.moveScenario(1)) return;
            if (!this.isLast) this.enterStep(this.step + 1);
            else if (this.completionFailed) void this.complete();
        },

        skip() {
            if (!this.isLast) this.enterStep(this.step + 1);
        },

        handleKey(event) {
            const target = event.target;
            if (target instanceof HTMLInputElement
                || target instanceof HTMLSelectElement
                || target instanceof HTMLButtonElement
                || target instanceof HTMLAnchorElement
                || (target instanceof HTMLElement && target.isContentEditable)) return;
            if (event.key === 'ArrowRight' && !this.nextDisabled) this.next();
            if (event.key === 'ArrowLeft' && this.step > 0) this.previous();
        },

        enterStep(nextStep, scenario) {
            this.step = nextStep;
            if (nextStep === SCENARIO_STEP) this.scenarioName = scenario ?? 'morning';
            if (nextStep === LOGIN_STEP && (!this.loginDataLoaded || this.needsLogin)) this.startLoginRefresh();
            else this.stopLoginRefresh();
            if (this.isLast && !this.onboardingCompleted && !this.completionPending && !this.completionFailed) {
                this.scheduleComplete();
            }
        },

        moveScenario(delta) {
            const current = SCENARIO_ORDER.indexOf(this.scenarioName);
            const next = SCENARIO_ORDER[current + delta];
            if (!next) return false;
            this.scenarioName = next;
            return true;
        },

        applyLoginStatus(status) {
            if (typeof status === 'boolean') {
                this.loginDataLoaded = true;
                this.needsLogin = status;
            } else {
                this.loginDataLoaded = Boolean(status.dataLoaded);
                this.needsLogin = !this.loginDataLoaded || Boolean(status.needsLogin);
            }
            if (this.loginDataLoaded && !this.needsLogin) this.stopLoginRefresh();
        },

        async syncLoginStatus() {
            try {
                this.applyLoginStatus(await invoke<LoginStatus>('get_login_status'));
            } catch (error) {
                console.error('[onboarding] login status sync failed', error);
            }
        },

        requestLoginRefresh() {
            void invoke('refresh_login_status').catch(console.error);
            window.setTimeout(() => void this.syncLoginStatus(), 1200);
        },

        startLoginRefresh() {
            if (this.loginRefreshTimer !== null) return;
            this.requestLoginRefresh();
            this.loginRefreshTimer = window.setInterval(() => {
                if (this.step === LOGIN_STEP && (!this.loginDataLoaded || this.needsLogin)) this.requestLoginRefresh();
                else this.stopLoginRefresh();
            }, 5000);
        },

        stopLoginRefresh() {
            if (this.loginRefreshTimer === null) return;
            window.clearInterval(this.loginRefreshTimer);
            this.loginRefreshTimer = null;
        },

        async openAttendance() {
            await invoke('open_attendance_window').catch(console.error);
            this.startLoginRefresh();
        },

        async complete() {
            if (this.onboardingCompleted || this.completionPending) return;
            this.completionPending = true;
            this.completionFailed = false;
            this.stopLoginRefresh();
            try {
                await invoke('complete_onboarding');
                this.onboardingCompleted = true;
            } catch (error) {
                console.error('[onboarding] complete failed', error);
                this.completionFailed = true;
            } finally {
                this.completionPending = false;
            }
        },

        scheduleComplete() {
            if (this.completionScheduled) return;
            this.completionScheduled = true;
            window.setTimeout(() => {
                this.completionScheduled = false;
                void this.complete();
            }, 0);
        },

        async hydrateNotificationSettings() {
            this.unlistenSettings = await connectSettingsSnapshots(
                this,
                projectNotificationSettings,
                (context, error) => console.error(`[onboarding] ${context} failed`, error),
            );
        },

        async restoreNotificationSettings(context, error, fallback) {
            console.error(`[onboarding] ${context} failed`, error);
            try {
                await refreshSettingsSnapshot(this, projectNotificationSettings);
            } catch (refreshError) {
                console.error('[onboarding] recovery snapshot failed', refreshError);
                if (this.lastSettingsSnapshot) {
                    projectNotificationSettings(this, this.lastSettingsSnapshot);
                } else {
                    fallback?.();
                }
            }
        },

        async saveToggle(command, field) {
            const value = this[field];
            try {
                await invokeSettingsMutation(this, projectNotificationSettings, command, {enabled: value});
            } catch (error) {
                await this.restoreNotificationSettings(command, error, () => {
                    this[field] = !value;
                });
            }
        },

        async saveTime(command, hour) {
            try {
                await invokeSettingsMutation(this, projectNotificationSettings, command, {hour, minute: 0});
            } catch (error) {
                await this.restoreNotificationSettings(command, error);
            }
        },

        async saveInterval(command, value) {
            try {
                await invokeSettingsMutation(this, projectNotificationSettings, command, {value});
            } catch (error) {
                await this.restoreNotificationSettings(command, error);
            }
        },

        async openNotificationSettings() {
            try { await invoke('open_notification_settings'); }
            catch (error) {
                console.error(error);
                await message(`시스템 알림 설정을 열지 못했습니다.\n${String(error)}`, {title: '알림 설정'});
            }
        },
    };
}

Alpine.data('onboarding', onboarding);
Alpine.start();
