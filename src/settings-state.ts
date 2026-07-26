import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';

export const SETTINGS_CHANGED_EVENT = 'settings-changed';

export interface TimeOfDay {
    hour: number;
    minute: number;
}

export interface SettingsSnapshot {
    revision: number;
    source: string;
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
    notificationStart: TimeOfDay;
    notificationEnd: TimeOfDay;
    startInterval: number;
    endInterval: number;
}

export interface SettingsSnapshotTarget {
    settingsRevision: number;
}

type ProjectSnapshot<T extends SettingsSnapshotTarget> = (
    target: T,
    snapshot: SettingsSnapshot,
) => void;

export function applySettingsSnapshot<T extends SettingsSnapshotTarget>(
    target: T,
    snapshot: SettingsSnapshot,
    project: (snapshot: SettingsSnapshot) => void,
): boolean {
    if (!Number.isSafeInteger(snapshot.revision)
        || snapshot.revision < 0
        || snapshot.revision <= target.settingsRevision) {
        return false;
    }

    project(snapshot);
    target.settingsRevision = snapshot.revision;
    return true;
}

export function applyRefreshedSettingsSnapshot<T extends SettingsSnapshotTarget>(
    target: T,
    snapshot: SettingsSnapshot,
    project: (snapshot: SettingsSnapshot) => void,
): boolean {
    if (applySettingsSnapshot(target, snapshot, project)) return true;
    if (snapshot.revision !== target.settingsRevision) return false;
    project(snapshot);
    return true;
}

export async function refreshSettingsSnapshot<T extends SettingsSnapshotTarget>(
    target: T,
    project: ProjectSnapshot<T>,
): Promise<SettingsSnapshot> {
    const snapshot = await invoke<SettingsSnapshot>('get_settings_snapshot');
    applyRefreshedSettingsSnapshot(target, snapshot, (value) => project(target, value));
    return snapshot;
}

export async function connectSettingsSnapshots<T extends SettingsSnapshotTarget>(
    target: T,
    project: ProjectSnapshot<T>,
    onError: (context: string, error: unknown) => void,
): Promise<UnlistenFn | null> {
    let unlisten: UnlistenFn | null = null;
    try {
        unlisten = await listen<SettingsSnapshot>(SETTINGS_CHANGED_EVENT, (event) => {
            applySettingsSnapshot(target, event.payload, (value) => project(target, value));
        });
    } catch (error) {
        onError('event subscription', error);
    }

    try {
        await refreshSettingsSnapshot(target, project);
    } catch (error) {
        onError('snapshot refresh', error);
    }
    return unlisten;
}

export async function invokeSettingsMutation<T extends SettingsSnapshotTarget>(
    target: T,
    project: ProjectSnapshot<T>,
    command: string,
    args?: Record<string, unknown>,
): Promise<SettingsSnapshot> {
    const snapshot = await invoke<SettingsSnapshot>(command, args);
    applySettingsSnapshot(target, snapshot, (value) => project(target, value));
    return snapshot;
}
