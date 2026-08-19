import {hasOwn} from '@/lib/object';
import type {
    DesktopCohortOption,
    DesktopSettings,
    DesktopSettingsAdapter,
    DesktopSettingsUpdate,
    DesktopUpdateStatus,
    NativeBridge,
} from '@/platform/contracts';

const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u;

export type {
    DesktopCohortOption,
    DesktopSettings,
    DesktopSettingsUpdate,
} from '@/platform/contracts';

export function createDashboardDesktopSettingsApi(
    nativeBridge: Pick<
        NativeBridge,
        | 'getDesktopSettings'
        | 'updateDesktopSettings'
        | 'checkDesktopUpdate'
        | 'installDesktopUpdate'
        | 'openLogFolder'
        | 'openSystemNotificationSettings'
    >,
): DesktopSettingsAdapter {
    return {
        async getDesktopSettings() {
            return parseDesktopSettings(await nativeBridge.getDesktopSettings());
        },
        async updateDesktopSettings(input) {
            const body = desktopSettingsInput(input);
            return parseDesktopSettings(await nativeBridge.updateDesktopSettings(body));
        },
        async checkDesktopUpdate() {
            return parseDesktopUpdateStatus(await nativeBridge.checkDesktopUpdate());
        },
        async installDesktopUpdate() {
            const result = await nativeBridge.installDesktopUpdate();
            if (result !== null && result !== undefined) throw invalidResponse();
        },
        async openLogFolder() {
            const result = await nativeBridge.openLogFolder();
            if (result !== null && result !== undefined) throw invalidResponse();
        },
        async openSystemNotificationSettings() {
            const result = await nativeBridge.openSystemNotificationSettings();
            if (result !== null && result !== undefined) throw invalidResponse();
        },
    };
}

function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    const keys = ['currentVersion', 'availableVersion'] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
        throw invalidResponse();
    }
    if (typeof source.currentVersion !== 'string' || !APP_VERSION_PATTERN.test(source.currentVersion)) {
        throw invalidResponse();
    }
    if (source.availableVersion !== null
        && (typeof source.availableVersion !== 'string'
            || !APP_VERSION_PATTERN.test(source.availableVersion))) {
        throw invalidResponse();
    }
    return {
        currentVersion: source.currentVersion,
        availableVersion: source.availableVersion as string | null,
    };
}

function parseDesktopSettings(value: unknown): DesktopSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    const keys = [
        'appVersion', 'autoStart', 'autoUpdate', 'usageAnalytics', 'debugMode',
        'selectedCohortId', 'effectiveCohortId', 'cohortOptions',
    ] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
        throw invalidResponse();
    }
    if ([source.autoStart, source.autoUpdate, source.usageAnalytics, source.debugMode]
        .some((value) => typeof value !== 'boolean')) throw invalidResponse();
    if (typeof source.appVersion !== 'string' || !APP_VERSION_PATTERN.test(source.appVersion)) {
        throw invalidResponse();
    }
    const cohortOptions = parseCohortOptions(source.cohortOptions);
    const selectedCohortId = nullableCohortId(source.selectedCohortId);
    const effectiveCohortId = nullableCohortId(source.effectiveCohortId);
    return {
        appVersion: source.appVersion,
        autoStart: source.autoStart as boolean,
        autoUpdate: source.autoUpdate as boolean,
        usageAnalytics: source.usageAnalytics as boolean,
        debugMode: source.debugMode as boolean,
        selectedCohortId,
        effectiveCohortId,
        cohortOptions,
    };
}

function desktopSettingsInput(input: DesktopSettingsUpdate): DesktopSettingsUpdate {
    if (!input || typeof input !== 'object' || [
        input.autoStart,
        input.autoUpdate,
        input.usageAnalytics,
        input.debugMode,
    ].some((value) => typeof value !== 'boolean')) {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
    const selectedCohortId = nullableCohortId(input.selectedCohortId, 'API_CLIENT_INVALID_ARGUMENT');
    return {
        autoStart: input.autoStart,
        autoUpdate: input.autoUpdate,
        usageAnalytics: input.usageAnalytics,
        debugMode: input.debugMode,
        selectedCohortId,
    };
}

function parseCohortOptions(value: unknown): DesktopCohortOption[] {
    if (!Array.isArray(value) || value.length > 32) throw invalidResponse();
    const ids = new Set<string>();
    return value.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidResponse();
        const source = entry as Record<string, unknown>;
        const keys = ['id', 'label', 'startDate', 'endDate', 'isActive'];
        if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
            throw invalidResponse();
        }
        const id = nullableCohortId(source.id);
        const label = source.label;
        if (!id || ids.has(id)
            || typeof label !== 'string'
            || label.length < 1
            || label.length > 80
            || label.trim() !== label
            || typeof source.isActive !== 'boolean') throw invalidResponse();
        const startDate = calendarDate(source.startDate);
        const endDate = source.endDate === null ? null : calendarDate(source.endDate);
        if (endDate && endDate < startDate) throw invalidResponse();
        ids.add(id);
        return {id, label, startDate, endDate, isActive: source.isActive};
    });
}

function nullableCohortId(value: unknown, code = 'API_RESPONSE_INVALID'): string | null {
    if (value === null) return null;
    if (typeof value !== 'string'
        || value.length < 1
        || value.length > 128
        || value.trim() !== value
        || [...value].some((character) => /[\u0000-\u001f\u007f]/u.test(character))) {
        throw new Error(code);
    }
    return value;
}

function calendarDate(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalidResponse();
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalidResponse();
    return value;
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
