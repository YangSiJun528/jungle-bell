import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {NativeInvoke} from '@/platform/contracts';

import {createTauriLifecycleAdapter, type DesktopLifecycleStatus} from './lifecycle';

const listen = vi.hoisted(() =>
    vi.fn<(event: string, handler: (event: {payload: unknown}) => void) => Promise<() => void>>(
        async () => () => undefined,
    ),
);

vi.mock('@tauri-apps/api/event', () => ({listen}));

const pendingStatus = {
    closeBehavior: 'hideToTray',
    closeToTrayNotice: 'pending',
    explicitQuitAvailable: true,
} as const;

beforeEach(() => listen.mockClear());

describe('TauriLifecycleAdapter', () => {
    it('수명주기 상태 조회·안내 확인·완전 종료를 좁은 command로 매핑한다', async () => {
        const invoke = vi.fn<NativeInvoke>(async (command) => {
            if (command === 'get_desktop_lifecycle_status') return pendingStatus;
            if (command === 'acknowledge_and_hide_to_tray') {
                return {...pendingStatus, closeToTrayNotice: 'acknowledged'};
            }
            return null;
        });
        const adapter = createTauriLifecycleAdapter(invoke);

        await expect(adapter.getStatus()).resolves.toEqual(pendingStatus);
        await expect(adapter.acknowledgeAndHideToTray()).resolves.toEqual({
            ...pendingStatus,
            closeToTrayNotice: 'acknowledged',
        });
        await expect(adapter.quit()).resolves.toBeUndefined();
        expect(invoke.mock.calls).toEqual([
            ['get_desktop_lifecycle_status'],
            ['acknowledge_and_hide_to_tray'],
            ['quit_desktop_app'],
        ]);
    });

    it.each([
        {...pendingStatus, legacy: true},
        {...pendingStatus, closeBehavior: 'close'},
        {...pendingStatus, closeToTrayNotice: 'shown'},
        {...pendingStatus, explicitQuitAvailable: false},
    ])('backend의 느슨하거나 잘못된 DTO를 거부한다: %#', async (value) => {
        const adapter = createTauriLifecycleAdapter(async () => value);
        await expect(adapter.getStatus()).rejects.toThrow('API_RESPONSE_INVALID');
    });

    it('최초 close-to-tray 이벤트 payload를 검증해 전달한다', async () => {
        const listener = vi.fn<(status: DesktopLifecycleStatus) => void>();
        const adapter = createTauriLifecycleAdapter(async () => pendingStatus);

        const unlisten = await adapter.subscribeCloseToTrayNotice(listener);

        expect(unlisten).toEqual(expect.any(Function));
        expect(listen).toHaveBeenCalledWith('desktop-close-to-tray', expect.any(Function));
        const eventHandler = listen.mock.calls[0]?.[1];
        eventHandler?.({payload: pendingStatus});
        eventHandler?.({payload: {...pendingStatus, extra: true}});
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(pendingStatus);
    });
});
