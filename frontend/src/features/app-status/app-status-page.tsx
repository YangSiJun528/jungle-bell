import type {AppStatusInput, AppStatusTab} from './app-status-model';
import {AppStatusPanel} from './app-status-panel';
import {ConnectedAppStatus} from './connected-app-status';

export interface AppStatusPageProps {
    input?: AppStatusInput;
    onOpenTab?: (tab: AppStatusTab) => void;
}

export function AppStatusPage({input, onOpenTab}: AppStatusPageProps) {
    if (input) return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
    return <ConnectedAppStatus onOpenTab={onOpenTab} />;
}
