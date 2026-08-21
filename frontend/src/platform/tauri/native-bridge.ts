import {invoke as tauriInvoke} from '@tauri-apps/api/core';

import {hasOwn} from '@/lib/object';
import type {DesktopHttpSessionBootstrap, NativeBridge, NativeInvoke} from '@/platform/contracts';

export type {NativeBridge, NativeInvoke} from '@/platform/contracts';

export function createNativeBridge(
    invokeCommand: NativeInvoke = (command, args) => tauriInvoke(command, args),
): NativeBridge {
    return {
        async bootstrapDesktopHttpSession() {
            return parseDesktopHttpSessionBootstrap(
                await invokeCommand('bootstrap_desktop_http_session'),
            );
        },
        getDesktopSettings: () => invokeCommand('get_desktop_settings'),
        updateDesktopSettings: (input) => invokeCommand('update_desktop_settings', {input}),
        checkDesktopUpdate: () => invokeCommand('check_desktop_update'),
        installDesktopUpdate: () => invokeCommand('install_desktop_update'),
        openLogFolder: () => invokeCommand('open_log_folder'),
        openSystemNotificationSettings: () => invokeCommand('open_system_notification_settings'),
        getDesktopConnectionState: () => invokeCommand('get_connected_service_status'),
        resetDesktopIdentity: () => invokeCommand('reset_desktop_identity', {confirmed: true}),
        refreshPlatformSync: () => invokeCommand('refresh_platform_sync'),
        openLmsLogin: () => invokeCommand('open_lms_login'),
        getNotificationInboxSnapshot: () => invokeCommand('get_notification_inbox_snapshot'),
        markNotificationRead: (id) => invokeCommand('mark_notification_read', {id}),
        markAllNotificationsRead: () => invokeCommand('mark_all_notifications_read'),
        activateNotification: (id) => invokeCommand('activate_notification', {id}),
        sendTestNotification: () => invokeCommand('send_test_notification'),
    };
}

function parseDesktopHttpSessionBootstrap(value: unknown): DesktopHttpSessionBootstrap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
    const source = value as Record<string, unknown>;
    if (
        Object.keys(source).length !== 2 ||
        !hasOwn(source, 'accessToken') ||
        !hasOwn(source, 'expiresAt') ||
        typeof source.accessToken !== 'string' ||
        !/^jbui_[0-9a-f]{64}$/u.test(source.accessToken) ||
        typeof source.expiresAt !== 'string'
    ) {
        throw invalidResponse();
    }
    const expiresAtEpochMs = Date.parse(source.expiresAt);
    if (
        !Number.isFinite(expiresAtEpochMs) ||
        new Date(expiresAtEpochMs).toISOString() !== source.expiresAt
    ) {
        throw invalidResponse();
    }
    return {accessToken: source.accessToken, expiresAt: source.expiresAt};
}

function invalidResponse(): Error {
    return new Error('API_RESPONSE_INVALID');
}
