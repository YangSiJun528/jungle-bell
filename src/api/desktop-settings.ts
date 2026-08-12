export interface DesktopSettings {
    autoStart: boolean;
    autoUpdate: boolean;
    usageAnalytics: boolean;
    debugMode: boolean;
}

export type DesktopSettingsInvoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

export interface DashboardDesktopSettingsApi {
    getDesktopSettings(): Promise<DesktopSettings>;
    updateDesktopSettings(input: DesktopSettings): Promise<DesktopSettings>;
    openLogFolder(): Promise<void>;
}

export function createDashboardDesktopSettingsApi(
    invokeCommand: DesktopSettingsInvoke,
): DashboardDesktopSettingsApi {
    return {
        async getDesktopSettings() {
            return parseDesktopSettings(await invokeCommand('get_desktop_settings'));
        },
        async updateDesktopSettings(input) {
            const body = desktopSettingsInput(input);
            return parseDesktopSettings(await invokeCommand('update_desktop_settings', {input: body}));
        },
        async openLogFolder() {
            const result = await invokeCommand('open_log_folder');
            if (result !== null && result !== undefined) throw invalidResponse();
        },
    };
}

function parseDesktopSettings(value: unknown): DesktopSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    const keys = ['autoStart', 'autoUpdate', 'usageAnalytics', 'debugMode'] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) {
        throw invalidResponse();
    }
    if (keys.some((key) => typeof source[key] !== 'boolean')) throw invalidResponse();
    return {
        autoStart: source.autoStart as boolean,
        autoUpdate: source.autoUpdate as boolean,
        usageAnalytics: source.usageAnalytics as boolean,
        debugMode: source.debugMode as boolean,
    };
}

function desktopSettingsInput(input: DesktopSettings): DesktopSettings {
    if (!input || typeof input !== 'object' || [
        input.autoStart,
        input.autoUpdate,
        input.usageAnalytics,
        input.debugMode,
    ].some((value) => typeof value !== 'boolean')) {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
    return {
        autoStart: input.autoStart,
        autoUpdate: input.autoUpdate,
        usageAnalytics: input.usageAnalytics,
        debugMode: input.debugMode,
    };
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
