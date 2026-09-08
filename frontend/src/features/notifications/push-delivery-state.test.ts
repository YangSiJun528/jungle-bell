import {describe, expect, test} from 'vitest';

import {
    createPushDeliveryState,
    pushDeliveryStepStates,
    reducePushDeliveryState,
    restoredPushDeliveryState,
} from './push-delivery-state';

describe('push delivery state machine', () => {
    test('재시작 뒤 실제 로컬 구독과 저장된 등록이 일치할 때만 등록 단계를 복구한다', () => {
        expect(restoredPushDeliveryState('matched-registered')).toEqual({
            permission: 'complete',
            localSubscription: 'complete',
            serverRegistration: 'complete',
            testSend: 'current',
            arrival: 'waiting',
        });

        for (const status of [
            'matched-registration-unverified',
            'matched-server-removed',
            'local-only',
            'record-only',
            'mismatch',
            'invalid',
            'failed',
        ] as const) {
            expect(restoredPushDeliveryState(status).serverRegistration).not.toBe('complete');
        }
    });

    test('등록 기록과 로컬 구독이 모두 없어도 정리 성공으로 추론하지 않는다', () => {
        expect(restoredPushDeliveryState('none')).toEqual(createPushDeliveryState('default'));
    });

    test('권한부터 실제 도착 확인까지 순서대로 한 단계만 활성화한다', () => {
        let state = createPushDeliveryState('default');

        expect(pushDeliveryStepStates(state).map(({status}) => status)).toEqual([
            'current',
            'waiting',
            'waiting',
            'waiting',
            'waiting',
        ]);

        state = reducePushDeliveryState(state, {type: 'local-subscribed'});
        expect(pushDeliveryStepStates(state).map(({status}) => status)).toEqual([
            'complete',
            'complete',
            'current',
            'waiting',
            'waiting',
        ]);

        state = reducePushDeliveryState(state, {type: 'server-registered'});
        expect(pushDeliveryStepStates(state).map(({status}) => status)).toEqual([
            'complete',
            'complete',
            'complete',
            'current',
            'waiting',
        ]);

        state = reducePushDeliveryState(state, {type: 'test-queued', queued: 1});
        expect(pushDeliveryStepStates(state).map(({status}) => status)).toEqual([
            'complete',
            'complete',
            'complete',
            'complete',
            'current',
        ]);

        state = reducePushDeliveryState(state, {type: 'arrival-confirmed'});
        expect(pushDeliveryStepStates(state).at(-1)?.status).toBe('complete');
    });

    test('테스트 대상 0대는 성공이나 실제 도착 확인 단계가 아니다', () => {
        let state = createPushDeliveryState('granted');
        state = reducePushDeliveryState(state, {type: 'local-subscribed'});
        state = reducePushDeliveryState(state, {type: 'server-registered'});
        state = reducePushDeliveryState(state, {type: 'test-queued', queued: 0});

        const steps = pushDeliveryStepStates(state);
        expect(steps.find(({id}) => id === 'test-send')?.status).toBe('error');
        expect(steps.find(({id}) => id === 'arrival')?.status).toBe('waiting');
    });

    test('권한 거부와 미도착은 실패 지점을 보존해 해당 단계에서 복구한다', () => {
        const denied = createPushDeliveryState('denied');
        expect(pushDeliveryStepStates(denied)[0]?.status).toBe('error');

        let missing = createPushDeliveryState('granted');
        missing = reducePushDeliveryState(missing, {type: 'local-subscribed'});
        missing = reducePushDeliveryState(missing, {type: 'server-registered'});
        missing = reducePushDeliveryState(missing, {type: 'test-queued', queued: 1});
        missing = reducePushDeliveryState(missing, {type: 'arrival-missing'});
        expect(pushDeliveryStepStates(missing).at(-1)?.status).toBe('error');

        missing = reducePushDeliveryState(missing, {type: 'test-started'});
        expect(pushDeliveryStepStates(missing).find(({id}) => id === 'test-send')?.status).toBe(
            'current',
        );
    });
});
