import type {NativeBridge} from './native-bridge';
import {hasOwn} from '@/lib/object';

export interface DesktopSettings {
    autoStart: boolean;
    autoUpdate: boolean;
    usageAnalytics: boolean;
    debugMode: boolean;
}

export interface DashboardDesktopSettingsApi {
    getDesktopSettings(): Promise<DesktopSettings>;
    updateDesktopSettings(input: DesktopSettings): Promise<DesktopSettings>;
    openLogFolder(): Promise<void>;
}

export function createDashboardDesktopSettingsApi(
    nativeBridge: Pick<NativeBridge, 'getDesktopSettings' | 'updateDesktopSettings' | 'openLogFolder'>,
): DashboardDesktopSettingsApi {
    return {
        async getDesktopSettings() {
            return parseDesktopSettings(await nativeBridge.getDesktopSettings());
        },
        async updateDesktopSettings(input) {
            const body = desktopSettingsInput(input);
            return parseDesktopSettings(await nativeBridge.updateDesktopSettings(body));
        },
        async openLogFolder() {
            const result = await nativeBridge.openLogFolder();
            if (result !== null && result !== undefined) throw invalidResponse();
        },
    };
}

function parseDesktopSettings(value: unknown): DesktopSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    const keys = ['autoStart', 'autoUpdate', 'usageAnalytics', 'debugMode'] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
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
