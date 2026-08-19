import {describe, expect, test, vi} from 'vitest';
import {createNativeBridge} from './native-bridge';

const validSession = {
    accessToken: `jbui_${'a'.repeat(64)}`,
    expiresAt: '2026-08-12T10:00:00.000Z',
};

describe('NativeBridge', () => {
    test('bootstraps with the exact no-argument command and strict DTO', async () => {
        const invoke = vi.fn(async () => validSession);
        const bridge = createNativeBridge(invoke);

        await expect(bridge.bootstrapDesktopHttpSession()).resolves.toEqual(validSession);
        expect(invoke).toHaveBeenCalledWith('bootstrap_desktop_http_session');
    });

    test.each([
        {...validSession, extra: true},
        {...validSession, accessToken: 'long-desktop-bearer'},
        {...validSession, expiresAt: '2026-08-12 10:00:00'},
    ])('rejects malformed bootstrap DTO %#', async (value) => {
        const bridge = createNativeBridge(async () => value);
        await expect(bridge.bootstrapDesktopHttpSession()).rejects.toThrow('API_RESPONSE_INVALID');
    });

    test('maps identity reset, settings, and local notification operations narrowly', async () => {
        const invoke = vi.fn(async () => null);
        const bridge = createNativeBridge(invoke);

        await bridge.resetDesktopIdentity();
        await bridge.updateDesktopSettings({autoStart: true});
        await bridge.getNotificationInboxSnapshot();
        await bridge.markNotificationRead('12');
        await bridge.markAllNotificationsRead();

        expect(invoke.mock.calls).toEqual([
            ['reset_desktop_identity', {confirmed: true}],
            ['update_desktop_settings', {input: {autoStart: true}}],
            ['get_notification_inbox_snapshot'],
            ['mark_notification_read', {id: '12'}],
            ['mark_all_notifications_read'],
        ]);
    });
});
