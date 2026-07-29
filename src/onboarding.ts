import Alpine from 'alpinejs';
import './select-control';
import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {message} from '@tauri-apps/plugin-dialog';
import {
    connectSettingsSnapshots,
    invokeSettingsMutation,
    refreshSettingsSnapshot,
    type SettingsSnapshot,
} from './settings-state';

type OsName = 'mac' | 'win';

interface LoginStatus {
    dataLoaded: boolean;
    needsLogin: boolean;
}

const TOTAL_STEPS = 4;
const LOGIN_STEP = 1;

interface OnboardingComponent {
    step: number;
    totalSteps: number;
    currentOs: OsName;
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
    unlistenLogin: UnlistenFn | null;
    unlistenSettings: UnlistenFn | null;
    loginRefreshTimer: number | null;
    get isLast(): boolean;
    get nextDisabled(): boolean;
    get finalActionDisabled(): boolean;
    get nextLabel(): string;
    get finalDescription(): string;
    init(): Promise<void>;
    destroy(): void;
    setOs(os: OsName): void;
    previous(): void;
    next(): Promise<void>;
    skip(): void;
    handleKey(event: KeyboardEvent): void;
    enterStep(nextStep: number): void;
    applyLoginStatus(status: LoginStatus | boolean): void;
    syncLoginStatus(): Promise<void>;
    requestLoginRefresh(): void;
    startLoginRefresh(): void;
    stopLoginRefresh(): void;
    openAttendance(): Promise<void>;
    complete(): Promise<void>;
    hydrateNotificationSettings(): Promise<void>;
    restoreNotificationSettings(context: string, error: unknown, fallback?: () => void): Promise<void>;
    saveToggle(command: string, field: 'startNotification' | 'endNotification'): Promise<void>;
    saveTime(command: string, hour: number): Promise<void>;
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
    target.lastSettingsSnapshot = snapshot;
}

function onboarding(): OnboardingComponent {
    return {
        step: 0,
        totalSteps: TOTAL_STEPS,
        currentOs: /Win/i.test(navigator.userAgent) ? 'win' : 'mac',
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
        unlistenLogin: null,
        unlistenSettings: null,
        loginRefreshTimer: null,

        get isLast() { return this.step === TOTAL_STEPS - 1; },
        get nextDisabled() { return this.step === LOGIN_STEP && (!this.loginDataLoaded || this.needsLogin); },
        get finalActionDisabled() { return this.completionPending; },
        get nextLabel() {
            if (!this.isLast) return '다음';
            if (this.completionPending) return '시작하는 중';
            if (this.completionFailed) return '다시 시도';
            return '시작하기';
        },
        get finalDescription() {
            if (this.completionPending) return '설정을 저장한 뒤 창을 닫고 있어요.';
            if (this.completionFailed && this.onboardingCompleted) {
                return '설정은 저장됐지만 창을 닫지 못했어요. 다시 시도해 주세요.';
            }
            if (this.completionFailed) return '완료 저장에 실패했어요. 다시 시도해 주세요.';
            return '설정을 확인한 뒤 시작하기를 눌러 완료해 주세요.';
        },
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

        previous() {
            if (this.completionPending) return;
            if (this.step > 0) this.enterStep(this.step - 1);
        },

        async next() {
            if (this.nextDisabled) return;
            if (!this.isLast) {
                this.enterStep(this.step + 1);
                return;
            }
            await this.complete();
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
            if (event.key === 'ArrowRight' && !this.nextDisabled) void this.next();
            if (event.key === 'ArrowLeft' && this.step > 0 && !this.completionPending) this.previous();
        },

        enterStep(nextStep) {
            this.step = nextStep;
            window.requestAnimationFrame(() => {
                void Alpine.nextTick(() => {
                    document
                        .querySelector<HTMLElement>(`[data-step-panel="${nextStep}"] h2`)
                        ?.focus();
                });
            });
            if (nextStep === LOGIN_STEP && (!this.loginDataLoaded || this.needsLogin)) this.startLoginRefresh();
            else this.stopLoginRefresh();
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
            if (this.completionPending) return;
            this.completionPending = true;
            this.completionFailed = false;
            this.stopLoginRefresh();
            try {
                if (!this.onboardingCompleted) {
                    await invoke('complete_onboarding');
                    this.onboardingCompleted = true;
                }
                await getCurrentWindow().close();
            } catch (error) {
                const context = this.onboardingCompleted ? 'window close' : 'complete';
                console.error(`[onboarding] ${context} failed`, error);
                this.completionFailed = true;
            } finally {
                this.completionPending = false;
            }
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
