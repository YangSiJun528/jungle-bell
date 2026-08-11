import {describe, expect, test, vi} from 'vitest';
import {mobilePairingLinkFromHash} from './mobile-identity';
import {
    automaticPairingAction,
    releasePairingStart,
    tryReservePairingStart,
    waitForPairingCompletion,
} from './pairing-flow';

describe('mobile pairing flow', () => {
    test('QR fragment를 연결 입력으로 복원한다', () => {
        expect(mobilePairingLinkFromHash('#pairing=jbp_123&challenge=jbpc_456')).toEqual({
            pairingId: 'jbp_123',
            challenge: 'jbpc_456',
        });
        expect(mobilePairingLinkFromHash('#home')).toBeNull();
    });

    test('일시적인 네트워크 오류 뒤 완료를 계속 확인한다', async () => {
        const complete = vi.fn()
            .mockRejectedValueOnce(new Error('NETWORK_ERROR'))
            .mockResolvedValueOnce('waiting')
            .mockResolvedValueOnce('completed');
        const pause = vi.fn().mockResolvedValue(undefined);

        await waitForPairingCompletion({pairingId: 'pairing', complete, pause});

        expect(complete).toHaveBeenCalledTimes(3);
        expect(pause).toHaveBeenNthCalledWith(1, 3_000);
        expect(pause).toHaveBeenNthCalledWith(2, 1_000);
    });

    test('만료 오류는 즉시 중단한다', async () => {
        const complete = vi.fn().mockRejectedValue(new Error('PAIRING_EXPIRED'));
        const pause = vi.fn().mockResolvedValue(undefined);
        await expect(waitForPairingCompletion({pairingId: 'pairing', complete, pause})).rejects.toThrow('PAIRING_EXPIRED');
        expect(pause).not.toHaveBeenCalled();
    });

    test('pending receipt가 없거나 잘못된 복원은 즉시 중단한다', async () => {
        for (const code of ['PAIRING_RECEIPT_INVALID', 'PAIRING_RECEIPT_MISSING']) {
            const complete = vi.fn().mockRejectedValue(new Error(code));
            const pause = vi.fn().mockResolvedValue(undefined);

            await expect(waitForPairingCompletion({pairingId: 'pairing', complete, pause})).rejects.toThrow(code);
            expect(complete).toHaveBeenCalledOnce();
            expect(pause).not.toHaveBeenCalled();
        }
    });

    test('출석 세션 초기화가 끝나기 전에는 복원·QR claim을 시작하지 않는다', () => {
        expect(automaticPairingAction({
            attendance: 'pending',
            alreadyHandled: false,
            hasRestoredPairing: true,
            hasQrLink: true,
        })).toBe('wait');
        expect(automaticPairingAction({
            attendance: 'error',
            alreadyHandled: false,
            hasRestoredPairing: true,
            hasQrLink: true,
        })).toBe('wait');
    });

    test('auth-required에서만 pending 복원을 QR보다 우선하고, loaded면 pending을 제거한다', () => {
        expect(automaticPairingAction({
            attendance: 'auth-required',
            alreadyHandled: false,
            hasRestoredPairing: true,
            hasQrLink: true,
        })).toBe('resume');
        expect(automaticPairingAction({
            attendance: 'auth-required',
            alreadyHandled: false,
            hasRestoredPairing: false,
            hasQrLink: true,
        })).toBe('qr');
        expect(automaticPairingAction({
            attendance: 'loaded',
            alreadyHandled: false,
            hasRestoredPairing: true,
            hasQrLink: true,
        })).toBe('clear');
        expect(automaticPairingAction({
            attendance: 'auth-required',
            alreadyHandled: true,
            hasRestoredPairing: true,
            hasQrLink: true,
        })).toBe('none');
    });

    test('수동 claim이 시작된 동안 QR 자동 claim을 중복 시작하지 않는다', () => {
        const gate = {inFlight: false, automaticHandled: false};

        expect(tryReservePairingStart(gate)).toBe(true);
        expect(gate).toEqual({inFlight: true, automaticHandled: true});
        expect(tryReservePairingStart(gate)).toBe(false);
        expect(automaticPairingAction({
            attendance: 'auth-required',
            alreadyHandled: gate.automaticHandled,
            hasRestoredPairing: false,
            hasQrLink: true,
        })).toBe('none');

        releasePairingStart(gate);
        expect(tryReservePairingStart(gate)).toBe(true);
        expect(gate.automaticHandled).toBe(true);
    });
});
