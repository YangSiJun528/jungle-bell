import {hasOwn, isRecord} from '@/lib/object';
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
    if (!isRecord(value)) throw invalidResponse();
    const source = value;
    const keys = ['currentVersion', 'availableVersion', 'mandatory'] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
        throw invalidResponse();
    }
    if (
        typeof source.currentVersion !== 'string' ||
        !APP_VERSION_PATTERN.test(source.currentVersion)
    ) {
        throw invalidResponse();
    }
    if (
        source.availableVersion !== null &&
        (typeof source.availableVersion !== 'string' ||
            !APP_VERSION_PATTERN.test(source.availableVersion))
    ) {
        throw invalidResponse();
    }
    if (
        typeof source.mandatory !== 'boolean' ||
        (source.mandatory && source.availableVersion === null)
    )
        throw invalidResponse();
    return {
        currentVersion: source.currentVersion,
        availableVersion: source.availableVersion,
        mandatory: source.mandatory,
    };
}

function parseDesktopSettings(value: unknown): DesktopSettings {
    if (!isRecord(value)) throw invalidResponse();
    const source = value;
    const keys = [
        'appVersion',
        'autoStart',
        'autoUpdate',
        'usageAnalytics',
        'usageAnalyticsSyncPending',
        'debugMode',
        'selectedCohortId',
        'effectiveCohortId',
        'cohortOptions',
    ] as const;
    if (Object.keys(source).length !== keys.length || keys.some((key) => !hasOwn(source, key))) {
        throw invalidResponse();
    }
    const {autoStart, autoUpdate, usageAnalyticsSyncPending, debugMode} = source;
    if (
        typeof autoStart !== 'boolean' ||
        typeof autoUpdate !== 'boolean' ||
        typeof usageAnalyticsSyncPending !== 'boolean' ||
        typeof debugMode !== 'boolean'
    ) {
        throw invalidResponse();
    }
    if (typeof source.appVersion !== 'string' || !APP_VERSION_PATTERN.test(source.appVersion)) {
        throw invalidResponse();
    }
    const cohortOptions = parseCohortOptions(source.cohortOptions);
    const usageAnalytics = nullableBoolean(source.usageAnalytics);
    const selectedCohortId = nullableCohortId(source.selectedCohortId);
    const effectiveCohortId = nullableCohortId(source.effectiveCohortId);
    return {
        appVersion: source.appVersion,
        autoStart,
        autoUpdate,
        usageAnalytics,
        usageAnalyticsSyncPending,
        debugMode,
        selectedCohortId,
        effectiveCohortId,
        cohortOptions,
    };
}

function desktopSettingsInput(input: DesktopSettingsUpdate): DesktopSettingsUpdate {
    if (
        !input ||
        typeof input !== 'object' ||
        [input.autoStart, input.autoUpdate, input.debugMode].some(
            (value) => typeof value !== 'boolean',
        ) ||
        (input.usageAnalytics !== null && typeof input.usageAnalytics !== 'boolean')
    ) {
        throw new Error('API_CLIENT_INVALID_ARGUMENT');
    }
    const selectedCohortId = nullableCohortId(
        input.selectedCohortId,
        'API_CLIENT_INVALID_ARGUMENT',
    );
    return {
        autoStart: input.autoStart,
        autoUpdate: input.autoUpdate,
        usageAnalytics: input.usageAnalytics,
        debugMode: input.debugMode,
        selectedCohortId,
    };
}

function nullableBoolean(value: unknown): boolean | null {
    if (value === null || typeof value === 'boolean') return value;
    throw invalidResponse();
}

function parseCohortOptions(value: unknown): DesktopCohortOption[] {
    if (!Array.isArray(value) || value.length > 32) throw invalidResponse();
    const ids = new Set<string>();
    return value.map((entry) => {
        if (!isRecord(entry)) throw invalidResponse();
        const source = entry;
        const keys = ['id', 'label', 'startDate', 'endDate', 'isActive'];
        if (
            Object.keys(source).length !== keys.length ||
            keys.some((key) => !hasOwn(source, key))
        ) {
            throw invalidResponse();
        }
        const id = nullableCohortId(source.id);
        const label = source.label;
        const isActive = source.isActive;
        if (
            !id ||
            ids.has(id) ||
            typeof label !== 'string' ||
            label.length < 1 ||
            label.length > 80 ||
            label.trim() !== label ||
            typeof isActive !== 'boolean'
        )
            throw invalidResponse();
        const startDate = calendarDate(source.startDate);
        const endDate = source.endDate === null ? null : calendarDate(source.endDate);
        if (endDate && endDate < startDate) throw invalidResponse();
        ids.add(id);
        return {id, label, startDate, endDate, isActive};
    });
}

function nullableCohortId(value: unknown, code = 'API_RESPONSE_INVALID'): string | null {
    if (value === null) return null;
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 128 ||
        value.trim() !== value ||
        Array.from(value).some((character) => /\p{Cc}/u.test(character))
    ) {
        throw new Error(code);
    }
    return value;
}

function calendarDate(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalidResponse();
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
        throw invalidResponse();
    return value;
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
