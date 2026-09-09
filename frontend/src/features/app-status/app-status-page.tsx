import type {AppStatusInput, AppStatusTab} from './app-status-model';
import {appStatusRows, appStatusWarningCount} from './app-status-model';
import {AppStatusPanel} from './app-status-panel';
import type {AppStatusRenderer} from './app-status-render';
import {ConnectedAppStatus} from './connected-app-status';

export interface AppStatusPageProps {
    children?: AppStatusRenderer;
    input?: AppStatusInput;
    onOpenTab?: (tab: AppStatusTab) => void;
}

export function AppStatusPage({children, input, onOpenTab}: AppStatusPageProps) {
    if (input) {
        const content = <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
        return children
            ? children({content, warningCount: appStatusWarningCount(appStatusRows(input))})
            : content;
    }
    return <ConnectedAppStatus onOpenTab={onOpenTab}>{children}</ConnectedAppStatus>;
}
