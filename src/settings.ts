import Alpine from 'alpinejs';
import './select-control';
import {invoke} from '@tauri-apps/api/core';
import type {UnlistenFn} from '@tauri-apps/api/event';
import {confirm, message} from '@tauri-apps/plugin-dialog';
import {
    AUTO_UPDATE_DISABLE_CONFIRMATION,
    requiresAutoUpdateDisableConfirmation,
} from './settings-confirmation';
import {
    connectSettingsSnapshots,
    invokeSettingsMutation,
    refreshSettingsSnapshot,
    type CohortOption,
    type NotificationDelivery,
    type SettingsSnapshot,
} from './settings-state';

type SettingsTab = 'notification' | 'app';

interface SettingsComponent {
    activeTab: SettingsTab;
    settingsRevision: number;
    lastSettingsSnapshot: SettingsSnapshot | null;
    unlistenSettings: UnlistenFn | null;
    appVersion: string;
    pendingVersion: string | null;
    autoStart: boolean;
    autoUpdate: boolean;
    showAppIcon: boolean;
    showDday: boolean;
    usageAnalytics: boolean;
    debugMode: boolean;
    skipAttendance: boolean;
    skipSunday: boolean;
    startNotification: boolean;
    endNotification: boolean;
    notificationDelivery: NotificationDelivery;
    mealSubscription: boolean;
    notificationStart: number;
    notificationEnd: number;
    selectedCohortId: string;
    effectiveCohortId: string | null;
    cohortOptions: CohortOption[];
    get attendanceNotificationEnabled(): boolean;
    get skipAttendanceHint(): string;
    init(): Promise<void>;
    destroy(): void;
    selectTab(tab: SettingsTab): Promise<void>;
    refreshSettings(): Promise<void>;
    restoreSettings(context: string, error: unknown, fallback?: () => void): Promise<void>;
    onFocus(): Promise<void>;
    setAttendanceNotification(enabled: boolean): Promise<void>;
    saveToggle(command: string, field: BooleanField): Promise<void>;
    saveStartTime(): Promise<void>;
    saveEndTime(): Promise<void>;
    saveNotificationDelivery(): Promise<void>;
    saveSelectedCohort(): Promise<void>;
    toggleAutoUpdate(): Promise<void>;
    toggleDebugMode(): Promise<void>;
    openNotificationSettings(): Promise<void>;
    command(command: string): Promise<void>;
}

type BooleanField =
    | 'autoStart'
    | 'autoUpdate'
    | 'showAppIcon'
    | 'showDday'
    | 'usageAnalytics'
    | 'skipAttendance'
    | 'skipSunday'
    | 'startNotification'
    | 'endNotification'
    | 'mealSubscription';

function projectSettings(target: SettingsComponent, snapshot: SettingsSnapshot): void {
    target.appVersion = snapshot.appVersion;
    target.pendingVersion = snapshot.pendingVersion;
    target.autoStart = snapshot.autoStart;
    target.autoUpdate = snapshot.autoUpdate;
    target.showAppIcon = snapshot.showAppIcon;
    target.showDday = snapshot.showDday;
    target.usageAnalytics = snapshot.usageAnalytics;
    target.debugMode = snapshot.debugMode;
    target.skipAttendance = snapshot.skipAttendance;
    target.skipSunday = snapshot.skipSunday;
    target.startNotification = snapshot.startNotification;
    target.endNotification = snapshot.endNotification;
    target.notificationDelivery = snapshot.notificationDelivery;
    target.mealSubscription = snapshot.mealSubscription;
    target.notificationStart = snapshot.notificationStart.hour;
    target.notificationEnd = snapshot.notificationEnd.hour;
    target.cohortOptions = snapshot.cohortOptions;
    target.selectedCohortId = snapshot.selectedCohortId
        && snapshot.cohortOptions.some((cohort) => cohort.id === snapshot.selectedCohortId)
        ? snapshot.selectedCohortId
        : '';
    target.effectiveCohortId = snapshot.effectiveCohortId;
    target.lastSettingsSnapshot = snapshot;
}

function settings(): SettingsComponent {
    return {
        activeTab: 'notification',
        settingsRevision: -1,
        lastSettingsSnapshot: null,
        unlistenSettings: null,
        appVersion: '',
        pendingVersion: null,
        autoStart: false,
        autoUpdate: false,
        showAppIcon: true,
        showDday: true,
        usageAnalytics: true,
        debugMode: false,
        skipAttendance: false,
        skipSunday: false,
        startNotification: true,
        endNotification: true,
        notificationDelivery: 'both',
        mealSubscription: true,
        notificationStart: 4,
        notificationEnd: 4,
        selectedCohortId: '',
        effectiveCohortId: null,
        cohortOptions: [],

        get attendanceNotificationEnabled() {
            return !this.skipAttendance;
        },

        get skipAttendanceHint() {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
            const day = String(tomorrow.getDate()).padStart(2, '0');
            return `내일(${month}/${day}) 출석 시작 시각에 자동으로 다시 켜집니다.`;
        },

        async init() {
            this.unlistenSettings = await connectSettingsSnapshots(
                this,
                projectSettings,
                (context, error) => console.error(`[settings] ${context} failed`, error),
            );
        },

        destroy() {
            this.unlistenSettings?.();
            this.unlistenSettings = null;
        },

        async selectTab(tab) {
            this.activeTab = tab;
            if (tab === 'app') await this.refreshSettings();
        },

        async refreshSettings() {
            try {
                await refreshSettingsSnapshot(this, projectSettings);
            } catch (error) {
                console.error('[settings] snapshot refresh failed', error);
            }
        },

        async restoreSettings(context, error, fallback) {
            console.error(`[settings] ${context} failed`, error);
            try {
                await refreshSettingsSnapshot(this, projectSettings);
            } catch (refreshError) {
                console.error('[settings] recovery snapshot failed', refreshError);
                if (this.lastSettingsSnapshot) projectSettings(this, this.lastSettingsSnapshot);
                else fallback?.();
            }
        },

        async onFocus() {
            await invoke('log_from_js', {level: 'info', message: '[settings] window focus'}).catch(console.error);
            await this.refreshSettings();
        },

        async setAttendanceNotification(enabled) {
            const previous = this.skipAttendance;
            this.skipAttendance = !enabled;
            try {
                await invokeSettingsMutation(
                    this,
                    projectSettings,
                    'set_skip_attendance',
                    {enabled: this.skipAttendance},
                );
            } catch (error) {
                await this.restoreSettings('set_skip_attendance', error, () => {
                    this.skipAttendance = previous;
                });
            }
        },

        async saveToggle(command, field) {
            const value = this[field];
            try {
                await invokeSettingsMutation(this, projectSettings, command, {enabled: value});
            } catch (error) {
                await this.restoreSettings(command, error, () => {
                    this[field] = !value;
                });
            }
        },

        async saveStartTime() {
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_notification_start', {
                    hour: this.notificationStart,
                    minute: 0,
                });
            } catch (error) {
                await this.restoreSettings('set_notification_start', error);
            }
        },

        async saveEndTime() {
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_notification_end', {
                    hour: this.notificationEnd,
                    minute: 0,
                });
            } catch (error) {
                await this.restoreSettings('set_notification_end', error);
            }
        },

        async saveNotificationDelivery() {
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_notification_delivery', {
                    delivery: this.notificationDelivery,
                });
            } catch (error) {
                await this.restoreSettings('set_notification_delivery', error);
            }
        },

        async saveSelectedCohort() {
            const previous = this.lastSettingsSnapshot?.selectedCohortId ?? '';
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_selected_cohort', {
                    cohortId: this.selectedCohortId || null,
                });
            } catch (error) {
                await this.restoreSettings('set_selected_cohort', error, () => {
                    this.selectedCohortId = previous;
                });
            }
        },

        async toggleAutoUpdate() {
            const value = this.autoUpdate;
            if (requiresAutoUpdateDisableConfirmation(value)) {
                const accepted = await confirm(
                    AUTO_UPDATE_DISABLE_CONFIRMATION.message,
                    {
                        title: AUTO_UPDATE_DISABLE_CONFIRMATION.title,
                        okLabel: AUTO_UPDATE_DISABLE_CONFIRMATION.okLabel,
                        cancelLabel: AUTO_UPDATE_DISABLE_CONFIRMATION.cancelLabel,
                    },
                );
                if (!accepted) {
                    this.autoUpdate = true;
                    return;
                }
            }
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_auto_update', {enabled: value});
            } catch (error) {
                await this.restoreSettings('set_auto_update', error, () => {
                    this.autoUpdate = !value;
                });
            }
        },

        async toggleDebugMode() {
            const value = this.debugMode;
            if (value) {
                const accepted = await confirm(
                    '디버그 모드를 활성화하면 API 요청/응답 데이터, 앱 내부 상태 등 상세 로그가 기록됩니다.\n' +
                    '로그 파일 크기가 빠르게 증가할 수 있으며, 문제 해결 후에는 비활성화를 권장합니다.',
                    {title: '디버그 모드 활성화', okLabel: '활성화', cancelLabel: '취소'},
                );
                if (!accepted) {
                    this.debugMode = false;
                    return;
                }
            }
            try {
                await invokeSettingsMutation(this, projectSettings, 'set_debug_mode', {enabled: value});
            } catch (error) {
                await this.restoreSettings('set_debug_mode', error, () => {
                    this.debugMode = !value;
                });
            }
        },

        async openNotificationSettings() {
            try {
                await invoke('open_notification_settings');
            } catch (error) {
                console.error('[settings] notification settings failed', error);
                await message(`시스템 알림 설정을 열지 못했습니다.\n${String(error)}`, {title: '알림 설정'});
            }
        },

        async command(command) {
            await invoke(command).catch((error) => console.error(`[settings] ${command} failed`, error));
        },
    };
}

Alpine.data('settings', settings);
Alpine.start();
