import {describe, expect, test, vi} from 'vitest';

import {
    automaticPairingAction,
    finishCompanionPairing,
    releasePairingStart,
    tryReservePairingStart,
    waitForPairingCompletion,
} from './pairing-flow';

describe('mobile pairing flow', () => {
    test('루트 게이트의 연결 완료는 현재 URL을 유지한 채 세션만 다시 확인한다', async () => {
        const navigate = vi
            .fn<(path: '/connections' | '/home') => Promise<unknown>>()
            .mockResolvedValue(undefined);
        const refreshSession = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);

        await finishCompanionPairing({completionPath: null, navigate, refreshSession});

        expect(navigate).not.toHaveBeenCalled();
        expect(refreshSession).toHaveBeenCalledOnce();
    });

    test('일시적인 네트워크 오류 뒤 완료를 계속 확인한다', async () => {
        const complete = vi
            .fn<(pairingId: string) => Promise<'completed' | 'waiting'>>()
            .mockRejectedValueOnce(new Error('NETWORK_ERROR'))
            .mockResolvedValueOnce('waiting')
            .mockResolvedValueOnce('completed');
        const pause = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

        await waitForPairingCompletion({pairingId: 'pairing', complete, pause});

        expect(complete).toHaveBeenCalledTimes(3);
        expect(pause).toHaveBeenNthCalledWith(1, 3_000);
        expect(pause).toHaveBeenNthCalledWith(2, 1_000);
    });

    test('만료 오류는 즉시 중단한다', async () => {
        const complete = vi
            .fn<(pairingId: string) => Promise<'completed' | 'waiting'>>()
            .mockRejectedValue(new Error('PAIRING_EXPIRED'));
        const pause = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
        await expect(
            waitForPairingCompletion({pairingId: 'pairing', complete, pause}),
        ).rejects.toThrow('PAIRING_EXPIRED');
        expect(pause).not.toHaveBeenCalled();
    });

    test('기본 승인 대기는 10분 pairing 유효 시간에 맞춰 600회 확인한다', async () => {
        const complete = vi
            .fn<(pairingId: string) => Promise<'completed' | 'waiting'>>()
            .mockResolvedValue('waiting');
        const pause = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

        await expect(
            waitForPairingCompletion({pairingId: 'pairing', complete, pause}),
        ).rejects.toThrow('PAIRING_EXPIRED');

        expect(complete).toHaveBeenCalledTimes(600);
        expect(pause).toHaveBeenCalledTimes(600);
    });

    test('pending receipt가 없거나 잘못된 복원은 즉시 중단한다', async () => {
        for (const code of ['PAIRING_RECEIPT_INVALID', 'PAIRING_RECEIPT_MISSING']) {
            const complete = vi
                .fn<(pairingId: string) => Promise<'completed' | 'waiting'>>()
                .mockRejectedValue(new Error(code));
            const pause = vi
                .fn<(milliseconds: number) => Promise<void>>()
                .mockResolvedValue(undefined);

            await expect(
                waitForPairingCompletion({pairingId: 'pairing', complete, pause}),
            ).rejects.toThrow(code);
            expect(complete).toHaveBeenCalledOnce();
            expect(pause).not.toHaveBeenCalled();
        }
    });

    test('계정 세션 확인이 끝나기 전에는 복원·QR claim을 시작하지 않는다', () => {
        expect(
            automaticPairingAction({
                account: 'checking',
                alreadyHandled: false,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('wait');
        expect(
            automaticPairingAction({
                account: 'error',
                alreadyHandled: false,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('wait');
        expect(
            automaticPairingAction({
                account: 'not-applicable',
                alreadyHandled: false,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('wait');
    });

    test('미연결 상태에서만 pending 복원을 QR보다 우선하고, 연결되면 pending을 제거한다', () => {
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: false,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('resume');
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: false,
                hasRestoredPairing: false,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('qr');
        expect(
            automaticPairingAction({
                account: 'connected',
                alreadyHandled: false,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('clear');
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: true,
                hasRestoredPairing: true,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('none');
    });

    test('수동 claim이 시작된 동안 QR 자동 claim을 중복 시작하지 않는다', () => {
        const gate = {inFlight: false, automaticHandled: false};

        expect(tryReservePairingStart(gate)).toBe(true);
        expect(gate).toEqual({inFlight: true, automaticHandled: true});
        expect(tryReservePairingStart(gate)).toBe(false);
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: gate.automaticHandled,
                hasRestoredPairing: false,
                hasQrLink: true,
                canClaimHandoff: true,
            }),
        ).toBe('none');

        releasePairingStart(gate);
        expect(tryReservePairingStart(gate)).toBe(true);
        expect(gate.automaticHandled).toBe(true);
    });

    test('설치 PWA는 복원할 claim이나 직접 QR이 없으면 handoff cookie를 확인한다', () => {
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: false,
                hasRestoredPairing: false,
                hasQrLink: false,
                canClaimHandoff: true,
            }),
        ).toBe('handoff');
        expect(
            automaticPairingAction({
                account: 'unconnected',
                alreadyHandled: false,
                hasRestoredPairing: false,
                hasQrLink: false,
                canClaimHandoff: false,
            }),
        ).toBe('none');
    });
});
