export type PushPermissionState = 'default' | 'denied' | 'granted';

export type PushDeliveryStepId =
    | 'permission'
    | 'local-subscription'
    | 'server-registration'
    | 'test-send'
    | 'arrival';

export type PushDeliveryStepStatus = 'complete' | 'current' | 'error' | 'waiting';

export interface PushDeliveryStepState {
    id: PushDeliveryStepId;
    status: PushDeliveryStepStatus;
}

export interface PushDeliveryState {
    permission: PushDeliveryStepStatus;
    localSubscription: PushDeliveryStepStatus;
    serverRegistration: PushDeliveryStepStatus;
    testSend: PushDeliveryStepStatus;
    arrival: PushDeliveryStepStatus;
}

export type RestoredPushSubscriptionStatus =
    | 'matched-registered'
    | 'matched-registration-unverified'
    | 'matched-server-removed'
    | 'local-only'
    | 'record-only'
    | 'mismatch'
    | 'none'
    | 'invalid'
    | 'failed';

export type PushDeliveryEvent =
    | {type: 'connection-started'}
    | {type: 'permission-denied'}
    | {type: 'local-subscription-failed'}
    | {type: 'local-subscribed'}
    | {type: 'server-registration-failed'}
    | {type: 'server-registered'}
    | {type: 'test-started'}
    | {type: 'test-failed'}
    | {type: 'test-queued'; queued: number}
    | {type: 'arrival-confirmed'}
    | {type: 'arrival-missing'};

export function createPushDeliveryState(permission: PushPermissionState): PushDeliveryState {
    return {
        permission:
            permission === 'granted' ? 'complete' : permission === 'denied' ? 'error' : 'current',
        localSubscription: permission === 'granted' ? 'current' : 'waiting',
        serverRegistration: 'waiting',
        testSend: 'waiting',
        arrival: 'waiting',
    };
}

export function restoredPushDeliveryState(
    status: RestoredPushSubscriptionStatus,
    permission: PushPermissionState = 'default',
): PushDeliveryState {
    if (status === 'matched-registered') {
        return {
            permission: 'complete',
            localSubscription: 'complete',
            serverRegistration: 'complete',
            testSend: 'current',
            arrival: 'waiting',
        };
    }
    if (
        status === 'matched-registration-unverified' ||
        status === 'matched-server-removed' ||
        status === 'local-only' ||
        status === 'mismatch'
    ) {
        return {
            permission: 'complete',
            localSubscription: 'complete',
            serverRegistration: 'error',
            testSend: 'waiting',
            arrival: 'waiting',
        };
    }
    if (status === 'record-only') {
        return {
            permission: 'complete',
            localSubscription: 'error',
            serverRegistration: 'error',
            testSend: 'waiting',
            arrival: 'waiting',
        };
    }
    if (status === 'invalid' || status === 'failed') {
        return {
            ...createPushDeliveryState('default'),
            serverRegistration: 'error',
        };
    }
    return createPushDeliveryState(permission);
}

export function reducePushDeliveryState(
    state: PushDeliveryState,
    event: PushDeliveryEvent,
): PushDeliveryState {
    switch (event.type) {
        case 'connection-started':
            return createPushDeliveryState('default');
        case 'permission-denied':
            return createPushDeliveryState('denied');
        case 'local-subscription-failed':
            return {
                ...state,
                permission: 'complete',
                localSubscription: 'error',
                serverRegistration: 'waiting',
                testSend: 'waiting',
                arrival: 'waiting',
            };
        case 'local-subscribed':
            return {
                permission: 'complete',
                localSubscription: 'complete',
                serverRegistration: 'current',
                testSend: 'waiting',
                arrival: 'waiting',
            };
        case 'server-registration-failed':
            return {
                ...state,
                serverRegistration: 'error',
                testSend: 'waiting',
                arrival: 'waiting',
            };
        case 'server-registered':
            return {
                permission: 'complete',
                localSubscription: 'complete',
                serverRegistration: 'complete',
                testSend: 'current',
                arrival: 'waiting',
            };
        case 'test-started':
            if (state.serverRegistration !== 'complete') return state;
            return {...state, testSend: 'current', arrival: 'waiting'};
        case 'test-failed':
            if (state.serverRegistration !== 'complete') return state;
            return {...state, testSend: 'error', arrival: 'waiting'};
        case 'test-queued':
            if (event.queued <= 0) return {...state, testSend: 'error', arrival: 'waiting'};
            return {...state, testSend: 'complete', arrival: 'current'};
        case 'arrival-confirmed':
            if (state.testSend !== 'complete') return state;
            return {...state, arrival: 'complete'};
        case 'arrival-missing':
            if (state.testSend !== 'complete') return state;
            return {...state, arrival: 'error'};
    }
    return state;
}

export function pushDeliveryStepStates(state: PushDeliveryState): PushDeliveryStepState[] {
    return [
        {id: 'permission', status: state.permission},
        {id: 'local-subscription', status: state.localSubscription},
        {id: 'server-registration', status: state.serverRegistration},
        {id: 'test-send', status: state.testSend},
        {id: 'arrival', status: state.arrival},
    ];
}
