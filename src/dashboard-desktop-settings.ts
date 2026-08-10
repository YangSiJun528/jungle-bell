export interface DesktopSettings {
    autoStart: boolean;
}

export type DesktopSettingsInvoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

export interface DashboardDesktopSettingsApi {
    getDesktopSettings(): Promise<DesktopSettings>;
    updateDesktopSettings(input: DesktopSettings): Promise<DesktopSettings>;
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
    };
}

function parseDesktopSettings(value: unknown): DesktopSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'autoStart')) throw invalidResponse();
    if (typeof source.autoStart !== 'boolean') throw invalidResponse();
    return {autoStart: source.autoStart};
}

function desktopSettingsInput(input: DesktopSettings): DesktopSettings {
    if (!input || typeof input !== 'object' || typeof input.autoStart !== 'boolean') {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
    return {autoStart: input.autoStart};
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
