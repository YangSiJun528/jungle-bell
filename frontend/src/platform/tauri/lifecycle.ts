import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

import {hasOwn, isRecord} from '@/lib/object';
import type {NativeInvoke} from '@/platform/contracts';

export type CloseToTrayNotice = 'unseen' | 'pending' | 'acknowledged';

export interface DesktopLifecycleStatus {
    readonly closeBehavior: 'hideToTray';
    readonly closeToTrayNotice: CloseToTrayNotice;
    readonly explicitQuitAvailable: true;
}

export interface TauriLifecycleAdapter {
    getStatus(): Promise<DesktopLifecycleStatus>;
    acknowledgeAndHideToTray(): Promise<DesktopLifecycleStatus>;
    quit(): Promise<void>;
    subscribeCloseToTrayNotice(
        listener: (status: DesktopLifecycleStatus) => void,
    ): Promise<() => void>;
}

function isCloseToTrayNotice(value: unknown): value is CloseToTrayNotice {
    return value === 'unseen' || value === 'pending' || value === 'acknowledged';
}

export function createTauriLifecycleAdapter(
    invokeCommand: NativeInvoke = (command, args) => tauriInvoke(command, args),
): TauriLifecycleAdapter {
    return {
        async getStatus() {
            return parseDesktopLifecycleStatus(await invokeCommand('get_desktop_lifecycle_status'));
        },
        async acknowledgeAndHideToTray() {
            return parseDesktopLifecycleStatus(await invokeCommand('acknowledge_and_hide_to_tray'));
        },
        async quit() {
            await invokeCommand('quit_desktop_app');
        },
        subscribeCloseToTrayNotice: (listener) =>
            listen<unknown>('desktop-close-to-tray', ({payload}) => {
                try {
                    listener(parseDesktopLifecycleStatus(payload));
                } catch {
                    // Native event payloads are an untrusted IPC boundary.
                }
            }),
    };
}

function parseDesktopLifecycleStatus(value: unknown): DesktopLifecycleStatus {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 3 ||
        !hasOwn(value, 'closeBehavior') ||
        value.closeBehavior !== 'hideToTray' ||
        !hasOwn(value, 'closeToTrayNotice') ||
        !isCloseToTrayNotice(value.closeToTrayNotice) ||
        !hasOwn(value, 'explicitQuitAvailable') ||
        value.explicitQuitAvailable !== true
    ) {
        throw new Error('API_RESPONSE_INVALID');
    }
    return {
        closeBehavior: value.closeBehavior,
        closeToTrayNotice: value.closeToTrayNotice,
        explicitQuitAvailable: value.explicitQuitAvailable,
    };
}
