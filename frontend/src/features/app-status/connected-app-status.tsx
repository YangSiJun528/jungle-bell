import {useDashboardEnvironment} from '@/app/dashboard-context';

import {
    appStatusRows,
    appStatusWarningCount,
    type AppStatusInput,
    type AppStatusTab,
} from './app-status-model';
import {AppStatusPanel} from './app-status-panel';
import type {AppStatusRenderer} from './app-status-render';
import {ConnectedDesktopStatus} from './connected-desktop-status';
import {ConnectedPwaStatus} from './connected-pwa-status';

export function ConnectedAppStatus({
    children,
    onOpenTab,
}: {
    children?: AppStatusRenderer;
    onOpenTab?: (tab: AppStatusTab) => void;
}) {
    const {platform} = useDashboardEnvironment();
    if (platform.kind === 'desktop') {
        return <ConnectedDesktopStatus onOpenTab={onOpenTab}>{children}</ConnectedDesktopStatus>;
    }
    if (platform.accountAuthentication.kind === 'cookie') {
        return <ConnectedPwaStatus onOpenTab={onOpenTab}>{children}</ConnectedPwaStatus>;
    }
    const input: AppStatusInput = {
        surface: 'web',
        installSupported: platform.capabilities.pwaInstall && platform.pwa.available,
        installed: platform.pwa.installed,
    };
    const content = <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
    return children
        ? children({content, warningCount: appStatusWarningCount(appStatusRows(input))})
        : content;
}
