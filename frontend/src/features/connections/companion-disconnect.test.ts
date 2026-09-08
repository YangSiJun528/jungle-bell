import {describe, expect, test, vi} from 'vitest';

import {disconnectCompanionWithPushCleanup} from './companion-disconnect';

describe('companion self-disconnect', () => {
    test('서버 인증을 잃기 전에 푸시 정리를 끝낸다', async () => {
        const order: string[] = [];
        const cleanup = vi.fn<() => Promise<{status: 'complete'}>>(async () => {
            order.push('push-cleanup');
            return {status: 'complete' as const};
        });
        const disconnect = vi.fn<() => Promise<void>>(async () => {
            order.push('session-disconnect');
        });

        await expect(
            disconnectCompanionWithPushCleanup({
                cleanupPush: cleanup,
                disconnectSession: disconnect,
            }),
        ).resolves.toEqual({session: 'disconnected', pushCleanup: {status: 'complete'}});
        expect(order).toEqual(['push-cleanup', 'session-disconnect']);
    });

    test('푸시 정리가 일부 실패해도 연결 해제 결과와 섞지 않는다', async () => {
        const incomplete = {
            status: 'incomplete' as const,
            reason: 'server-unregister-failed',
        };

        await expect(
            disconnectCompanionWithPushCleanup({
                cleanupPush: async () => incomplete,
                disconnectSession: async () => undefined,
            }),
        ).resolves.toEqual({session: 'disconnected', pushCleanup: incomplete});
    });

    test('연결 해제 실패 뒤 재시도에서는 이미 완료한 푸시 정리를 반복하지 않는다', async () => {
        const complete = {status: 'complete' as const};
        const cleanup = vi.fn<() => Promise<{status: 'complete'}>>(async () => complete);

        const first = await disconnectCompanionWithPushCleanup({
            cleanupPush: cleanup,
            disconnectSession: async () => {
                throw new Error('NETWORK_ERROR');
            },
        });
        expect(first).toMatchObject({session: 'connected', pushCleanup: complete});

        await expect(
            disconnectCompanionWithPushCleanup({
                cleanupPush: cleanup,
                disconnectSession: async () => undefined,
                previousCleanup: first.pushCleanup,
            }),
        ).resolves.toEqual({session: 'disconnected', pushCleanup: complete});
        expect(cleanup).toHaveBeenCalledOnce();
    });

    test('예상하지 못한 정리 예외도 연결 해제 성공으로 둔갑시키지 않는다', async () => {
        const result = await disconnectCompanionWithPushCleanup({
            cleanupPush: async () => {
                throw new Error('STORAGE_BLOCKED');
            },
            disconnectSession: async () => undefined,
        });

        expect(result).toMatchObject({
            session: 'disconnected',
            pushCleanup: {status: 'incomplete', reason: 'cleanup-failed'},
        });
    });
});
