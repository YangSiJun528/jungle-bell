export type TimeOfDay = {
  hour: number;
  minute: number;
};

export type LoginStatus = {
  dataLoaded: boolean;
  needsLogin: boolean;
};

export type SettingsSnapshot = {
  appVersion: string;
  pendingUpdate: string | null;
  autoStart: boolean;
  autoUpdate: boolean;
  showDday: boolean;
  usageAnalyticsEnabled: boolean;
  debugMode: boolean;
  skipAttendance: boolean;
  skipSunday: boolean;
  startNotificationEnabled: boolean;
  endNotificationEnabled: boolean;
  notificationStart: TimeOfDay;
  notificationEnd: TimeOfDay;
  startNotificationInterval: number;
  endNotificationInterval: number;
};

type CommandResults = {
  get_settings: SettingsSnapshot;
  get_pending_update: string | null;
  get_app_version: string;
  get_auto_start: boolean;
  set_auto_start: void;
  get_auto_update: boolean;
  set_auto_update: void;
  get_show_dday: boolean;
  set_show_dday: void;
  get_usage_analytics_enabled: boolean;
  set_usage_analytics_enabled: void;
  get_debug_mode: boolean;
  set_debug_mode: void;
  get_skip_attendance: boolean;
  set_skip_attendance: void;
  get_skip_sunday: boolean;
  set_skip_sunday: void;
  get_start_notification_enabled: boolean;
  set_start_notification_enabled: void;
  get_end_notification_enabled: boolean;
  set_end_notification_enabled: void;
  get_notification_start: TimeOfDay;
  set_notification_start: void;
  get_start_notification_interval: number;
  set_start_notification_interval: void;
  get_notification_end: TimeOfDay;
  set_notification_end: void;
  get_end_notification_interval: number;
  set_end_notification_interval: void;
  open_notification_settings: void;
  open_log_folder: void;
  open_onboarding: void;
  open_attendance_window: void;
  check_and_notify_update: void;
  complete_onboarding: void;
  get_login_status: LoginStatus;
  refresh_login_status: void;
  log_from_js: void;
};

type CommandArgs = {
  get_settings: undefined;
  get_pending_update: undefined;
  get_app_version: undefined;
  get_auto_start: undefined;
  set_auto_start: {enabled: boolean};
  get_auto_update: undefined;
  set_auto_update: {enabled: boolean};
  get_show_dday: undefined;
  set_show_dday: {enabled: boolean};
  get_usage_analytics_enabled: undefined;
  set_usage_analytics_enabled: {enabled: boolean};
  get_debug_mode: undefined;
  set_debug_mode: {enabled: boolean};
  get_skip_attendance: undefined;
  set_skip_attendance: {enabled: boolean};
  get_skip_sunday: undefined;
  set_skip_sunday: {enabled: boolean};
  get_start_notification_enabled: undefined;
  set_start_notification_enabled: {enabled: boolean};
  get_end_notification_enabled: undefined;
  set_end_notification_enabled: {enabled: boolean};
  get_notification_start: undefined;
  set_notification_start: TimeOfDay;
  get_start_notification_interval: undefined;
  set_start_notification_interval: {value: number};
  get_notification_end: undefined;
  set_notification_end: TimeOfDay;
  get_end_notification_interval: undefined;
  set_end_notification_interval: {value: number};
  open_notification_settings: undefined;
  open_log_folder: undefined;
  open_onboarding: undefined;
  open_attendance_window: undefined;
  check_and_notify_update: undefined;
  complete_onboarding: undefined;
  get_login_status: undefined;
  refresh_login_status: undefined;
  log_from_js: {level: 'debug' | 'info' | 'warn' | 'error'; message: string};
};

type TauriEvent<T> = {
  payload: T;
};

type Unlisten = () => void;

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
      dialog?: {
        confirm(message: string, options?: Record<string, unknown>): Promise<boolean>;
        message(message: string, options?: Record<string, unknown>): Promise<void>;
      };
      event?: {
        listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<Unlisten>;
      };
    };
  }
}

const mockState = {
  autoStart: true,
  autoUpdate: true,
  showDday: true,
  usageAnalyticsEnabled: true,
  debugMode: false,
  skipAttendance: false,
  skipSunday: false,
  startNotificationEnabled: true,
  endNotificationEnabled: true,
  notificationStart: {hour: 4, minute: 0},
  notificationEnd: {hour: 4, minute: 0},
  startNotificationInterval: 5,
  endNotificationInterval: 5,
  loginStatus: {dataLoaded: true, needsLogin: false},
};

function getTauri() {
  return window.__TAURI__;
}

export function logFromFrontend(level: CommandArgs['log_from_js']['level'], message: string) {
  const tauri = getTauri();
  if (!tauri) {
    return;
  }
  tauri.core.invoke('log_from_js', {level, message}).catch(() => {});
}

export function installFrontendDiagnostics(scope: string) {
  logFromFrontend('info', `[${scope}] entry loaded`);
  window.addEventListener('error', event => {
    logFromFrontend('error', `[${scope}] window error: ${event.message}`);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    logFromFrontend('error', `[${scope}] unhandled rejection: ${reason}`);
  });
}

function mockInvoke<K extends keyof CommandResults>(
  command: K,
  args?: CommandArgs[K],
): CommandResults[K] {
  switch (command) {
    case 'get_settings':
      return {
        appVersion: '0.3.7-beta.0',
        pendingUpdate: null,
        autoStart: mockState.autoStart,
        autoUpdate: mockState.autoUpdate,
        showDday: mockState.showDday,
        usageAnalyticsEnabled: mockState.usageAnalyticsEnabled,
        debugMode: mockState.debugMode,
        skipAttendance: mockState.skipAttendance,
        skipSunday: mockState.skipSunday,
        startNotificationEnabled: mockState.startNotificationEnabled,
        endNotificationEnabled: mockState.endNotificationEnabled,
        notificationStart: mockState.notificationStart,
        notificationEnd: mockState.notificationEnd,
        startNotificationInterval: mockState.startNotificationInterval,
        endNotificationInterval: mockState.endNotificationInterval,
      } as CommandResults[K];
    case 'get_pending_update':
      return null as CommandResults[K];
    case 'get_app_version':
      return '0.3.7-beta.0' as CommandResults[K];
    case 'get_auto_start':
      return mockState.autoStart as CommandResults[K];
    case 'set_auto_start':
      mockState.autoStart = Boolean((args as CommandArgs['set_auto_start']).enabled);
      return undefined as CommandResults[K];
    case 'get_auto_update':
      return mockState.autoUpdate as CommandResults[K];
    case 'set_auto_update':
      mockState.autoUpdate = Boolean((args as CommandArgs['set_auto_update']).enabled);
      return undefined as CommandResults[K];
    case 'get_show_dday':
      return mockState.showDday as CommandResults[K];
    case 'set_show_dday':
      mockState.showDday = Boolean((args as CommandArgs['set_show_dday']).enabled);
      return undefined as CommandResults[K];
    case 'get_usage_analytics_enabled':
      return mockState.usageAnalyticsEnabled as CommandResults[K];
    case 'set_usage_analytics_enabled':
      mockState.usageAnalyticsEnabled = Boolean((args as CommandArgs['set_usage_analytics_enabled']).enabled);
      return undefined as CommandResults[K];
    case 'get_debug_mode':
      return mockState.debugMode as CommandResults[K];
    case 'set_debug_mode':
      mockState.debugMode = Boolean((args as CommandArgs['set_debug_mode']).enabled);
      return undefined as CommandResults[K];
    case 'get_skip_attendance':
      return mockState.skipAttendance as CommandResults[K];
    case 'set_skip_attendance':
      mockState.skipAttendance = Boolean((args as CommandArgs['set_skip_attendance']).enabled);
      return undefined as CommandResults[K];
    case 'get_skip_sunday':
      return mockState.skipSunday as CommandResults[K];
    case 'set_skip_sunday':
      mockState.skipSunday = Boolean((args as CommandArgs['set_skip_sunday']).enabled);
      return undefined as CommandResults[K];
    case 'get_start_notification_enabled':
      return mockState.startNotificationEnabled as CommandResults[K];
    case 'set_start_notification_enabled':
      mockState.startNotificationEnabled = Boolean((args as CommandArgs['set_start_notification_enabled']).enabled);
      return undefined as CommandResults[K];
    case 'get_end_notification_enabled':
      return mockState.endNotificationEnabled as CommandResults[K];
    case 'set_end_notification_enabled':
      mockState.endNotificationEnabled = Boolean((args as CommandArgs['set_end_notification_enabled']).enabled);
      return undefined as CommandResults[K];
    case 'get_notification_start':
      return mockState.notificationStart as CommandResults[K];
    case 'set_notification_start':
      mockState.notificationStart = args as CommandArgs['set_notification_start'];
      return undefined as CommandResults[K];
    case 'get_start_notification_interval':
      return mockState.startNotificationInterval as CommandResults[K];
    case 'set_start_notification_interval':
      mockState.startNotificationInterval = Number((args as CommandArgs['set_start_notification_interval']).value);
      return undefined as CommandResults[K];
    case 'get_notification_end':
      return mockState.notificationEnd as CommandResults[K];
    case 'set_notification_end':
      mockState.notificationEnd = args as CommandArgs['set_notification_end'];
      return undefined as CommandResults[K];
    case 'get_end_notification_interval':
      return mockState.endNotificationInterval as CommandResults[K];
    case 'set_end_notification_interval':
      mockState.endNotificationInterval = Number((args as CommandArgs['set_end_notification_interval']).value);
      return undefined as CommandResults[K];
    case 'get_login_status':
      return mockState.loginStatus as CommandResults[K];
    default:
      return undefined as CommandResults[K];
  }
}

export async function invokeCommand<K extends keyof CommandResults>(
  command: K,
  args?: CommandArgs[K],
): Promise<CommandResults[K]> {
  const tauri = getTauri();
  if (!tauri) {
    return mockInvoke(command, args);
  }

  return tauri.core.invoke<CommandResults[K]>(
    command,
    args as Record<string, unknown> | undefined,
  );
}

export async function confirmDialog(message: string, options?: Record<string, unknown>): Promise<boolean> {
  const dialog = getTauri()?.dialog;
  if (!dialog) {
    return window.confirm(message);
  }
  return dialog.confirm(message, options);
}

export async function messageDialog(message: string, options?: Record<string, unknown>): Promise<void> {
  const dialog = getTauri()?.dialog;
  if (!dialog) {
    window.alert(message);
    return;
  }
  await dialog.message(message, options);
}

export async function listenLoginStatusChanged(
  handler: (status: LoginStatus) => void,
): Promise<Unlisten> {
  const events = getTauri()?.event;
  if (!events) {
    return () => {};
  }
  return events.listen<LoginStatus>('login-status-changed', event => handler(event.payload));
}
