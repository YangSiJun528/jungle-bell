import type {PwaInstallPrompt} from '@/platform/contracts';

export type InstallPromptStatus =
    | 'available'
    | 'unsupported'
    | 'dismissed'
    | 'completed'
    | 'already-installed';

export type InstallPromptState =
    | {status: 'available'; prompt: PwaInstallPrompt}
    | {status: Exclude<InstallPromptStatus, 'available'>};

export type InstallPromptAction =
    | {type: 'prompt-available'; prompt: PwaInstallPrompt}
    | {type: 'prompt-dismissed'}
    | {type: 'prompt-accepted'}
    | {type: 'prompt-failed'}
    | {type: 'retry'}
    | {type: 'app-installed'};

export function initialInstallPromptState(installed: boolean): InstallPromptState {
    return installed ? {status: 'already-installed'} : {status: 'unsupported'};
}

export function reduceInstallPromptState(
    state: InstallPromptState,
    action: InstallPromptAction,
): InstallPromptState {
    switch (action.type) {
        case 'prompt-available':
            return state.status === 'already-installed' || state.status === 'completed'
                ? state
                : {status: 'available', prompt: action.prompt};
        case 'prompt-dismissed':
            return {status: 'dismissed'};
        case 'prompt-accepted':
        case 'app-installed':
            return {status: 'completed'};
        case 'prompt-failed':
        case 'retry':
            return state.status === 'already-installed' || state.status === 'completed'
                ? state
                : {status: 'unsupported'};
    }
    return state;
}
