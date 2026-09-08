import type {DesktopLifecycleStatus} from '@/platform/tauri/lifecycle';

export interface DesktopLifecycleState {
    readonly phase: 'checking' | 'ready' | 'unavailable';
    readonly status: DesktopLifecycleStatus | null;
    readonly noticeOpen: boolean;
    readonly detailsOpen: boolean;
    readonly operation: 'idle' | 'acknowledging' | 'quitting';
    readonly error: 'DESKTOP_LIFECYCLE_ACTION_FAILED' | 'DESKTOP_LIFECYCLE_STATUS_FAILED' | null;
}

export type DesktopLifecycleAction =
    | {type: 'unavailable'}
    | {type: 'status-loaded'; status: DesktopLifecycleStatus}
    | {type: 'status-failed'}
    | {type: 'close-requested'; status: DesktopLifecycleStatus}
    | {type: 'show-details'}
    | {type: 'hide-details'}
    | {type: 'acknowledge-started'}
    | {type: 'acknowledge-succeeded'; status: DesktopLifecycleStatus}
    | {type: 'quit-started'}
    | {type: 'quit-returned'}
    | {type: 'operation-failed'};

export const initialDesktopLifecycleState: DesktopLifecycleState = {
    phase: 'checking',
    status: null,
    noticeOpen: false,
    detailsOpen: false,
    operation: 'idle',
    error: null,
};

export function desktopLifecycleTransition(
    state: DesktopLifecycleState,
    action: DesktopLifecycleAction,
): DesktopLifecycleState {
    switch (action.type) {
        case 'unavailable':
            return {...initialDesktopLifecycleState, phase: 'unavailable'};
        case 'status-loaded':
            if (
                state.noticeOpen &&
                state.status?.closeToTrayNotice === 'pending' &&
                action.status.closeToTrayNotice === 'unseen'
            ) {
                return {...state, phase: 'ready'};
            }
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: action.status.closeToTrayNotice === 'pending',
                error: null,
            };
        case 'status-failed':
            return {...state, phase: 'ready', error: 'DESKTOP_LIFECYCLE_STATUS_FAILED'};
        case 'close-requested':
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: true,
                detailsOpen: false,
                error: null,
            };
        case 'show-details':
            return {...state, detailsOpen: true, error: null};
        case 'hide-details':
            return {...state, detailsOpen: false, error: null};
        case 'acknowledge-started':
            return {...state, operation: 'acknowledging', error: null};
        case 'acknowledge-succeeded':
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: false,
                detailsOpen: false,
                operation: 'idle',
                error: null,
            };
        case 'quit-started':
            return {...state, operation: 'quitting', error: null};
        case 'quit-returned':
            return {...state, operation: 'idle'};
        case 'operation-failed':
            return {
                ...state,
                operation: 'idle',
                error: 'DESKTOP_LIFECYCLE_ACTION_FAILED',
            };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}
