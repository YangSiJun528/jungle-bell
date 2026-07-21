import Alpine from 'alpinejs';
import './select-control';
import {invoke} from '@tauri-apps/api/core';
import {confirm, message} from '@tauri-apps/plugin-dialog';

type SettingsTab = 'notification' | 'app';

interface TimeOfDay {
    hour: number;
    minute: number;
}

interface SettingsComponent {
    activeTab: SettingsTab;
    appVersion: string;
    pendingVersion: string | null;
    autoStart: boolean;
    autoUpdate: boolean;
    showDday: boolean;
    usageAnalytics: boolean;
    debugMode: boolean;
    skipAttendance: boolean;
    skipSunday: boolean;
    startNotification: boolean;
    endNotification: boolean;
    notificationStart: number;
    notificationEnd: number;
    startInterval: number;
    endInterval: number;
    get attendanceNotificationEnabled(): boolean;
    get skipAttendanceHint(): string;
    init(): Promise<void>;
    selectTab(tab: SettingsTab): Promise<void>;
    refreshUpdateStatus(): Promise<void>;
    refreshSkipAttendance(): Promise<void>;
    onFocus(): Promise<void>;
    setAttendanceNotification(enabled: boolean): Promise<void>;
    saveToggle(command: string, field: BooleanField): Promise<void>;
    saveStartTime(): Promise<void>;
    saveEndTime(): Promise<void>;
    saveStartInterval(): Promise<void>;
    saveEndInterval(): Promise<void>;
    toggleDebugMode(): Promise<void>;
    openNotificationSettings(): Promise<void>;
    command(command: string): Promise<void>;
}

type BooleanField =
    | 'autoStart'
    | 'autoUpdate'
    | 'showDday'
    | 'usageAnalytics'
    | 'skipAttendance'
    | 'skipSunday'
    | 'startNotification'
    | 'endNotification';

function settings(): SettingsComponent {
    return {
        activeTab: 'notification',
        appVersion: '',
        pendingVersion: null,
        autoStart: false,
        autoUpdate: false,
        showDday: true,
        usageAnalytics: true,
        debugMode: false,
        skipAttendance: false,
        skipSunday: false,
        startNotification: true,
        endNotification: true,
        notificationStart: 4,
        notificationEnd: 4,
        startInterval: 15,
        endInterval: 15,

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
            const load = async <T>(command: string, apply: (value: T) => void) => {
                try {
                    apply(await invoke<T>(command));
                } catch (error) {
                    console.error(`[settings] ${command} failed`, error);
                }
            };

            await Promise.all([
                load<string>('get_app_version', (value) => { this.appVersion = value; }),
                load<boolean>('get_auto_start', (value) => { this.autoStart = value; }),
                load<boolean>('get_auto_update', (value) => { this.autoUpdate = value; }),
                load<boolean>('get_show_dday', (value) => { this.showDday = value; }),
                load<boolean>('get_usage_analytics_enabled', (value) => { this.usageAnalytics = value; }),
                load<boolean>('get_debug_mode', (value) => { this.debugMode = value; }),
                load<boolean>('get_skip_attendance', (value) => { this.skipAttendance = value; }),
                load<boolean>('get_skip_sunday', (value) => { this.skipSunday = value; }),
                load<boolean>('get_start_notification_enabled', (value) => { this.startNotification = value; }),
                load<boolean>('get_end_notification_enabled', (value) => { this.endNotification = value; }),
                load<TimeOfDay>('get_notification_start', (value) => { this.notificationStart = value.hour; }),
                load<TimeOfDay>('get_notification_end', (value) => { this.notificationEnd = value.hour; }),
                load<number>('get_start_notification_interval', (value) => { this.startInterval = value; }),
                load<number>('get_end_notification_interval', (value) => { this.endInterval = value; }),
                this.refreshUpdateStatus(),
            ]);
        },

        async selectTab(tab) {
            this.activeTab = tab;
            if (tab === 'app') await this.refreshUpdateStatus();
        },

        async refreshUpdateStatus() {
            try {
                this.pendingVersion = await invoke<string | null>('get_pending_update');
            } catch (error) {
                console.error('[settings] update status failed', error);
            }
        },

        async refreshSkipAttendance() {
            try {
                this.skipAttendance = await invoke<boolean>('get_skip_attendance');
            } catch (error) {
                console.error('[settings] skip attendance refresh failed', error);
            }
        },

        async onFocus() {
            await invoke('log_from_js', {level: 'info', message: '[settings] window focus'}).catch(console.error);
            await Promise.all([this.refreshSkipAttendance(), this.refreshUpdateStatus()]);
        },

        async setAttendanceNotification(enabled) {
            const previous = this.skipAttendance;
            this.skipAttendance = !enabled;
            try {
                await invoke('set_skip_attendance', {enabled: this.skipAttendance});
            } catch (error) {
                console.error('[settings] set_skip_attendance failed', error);
                this.skipAttendance = previous;
            }
        },

        async saveToggle(command, field) {
            const value = this[field];
            try {
                await invoke(command, {enabled: value});
            } catch (error) {
                console.error(`[settings] ${command} failed`, error);
                this[field] = !value;
            }
        },

        async saveStartTime() {
            await invoke('set_notification_start', {hour: this.notificationStart, minute: 0}).catch(console.error);
        },

        async saveEndTime() {
            await invoke('set_notification_end', {hour: this.notificationEnd, minute: 0}).catch(console.error);
        },

        async saveStartInterval() {
            await invoke('set_start_notification_interval', {value: this.startInterval}).catch(console.error);
        },

        async saveEndInterval() {
            await invoke('set_end_notification_interval', {value: this.endInterval}).catch(console.error);
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
                await invoke('set_debug_mode', {enabled: value});
            } catch (error) {
                console.error('[settings] debug mode update failed', error);
                this.debugMode = !value;
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
