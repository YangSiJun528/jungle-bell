import {useDashboardEnvironment} from '@/app/dashboard-context';

import type {AppStatusTab} from './app-status-model';
import {AppStatusPanel} from './app-status-panel';
import {ConnectedDesktopStatus} from './connected-desktop-status';
import {ConnectedPwaStatus} from './connected-pwa-status';

export function ConnectedAppStatus({onOpenTab}: {onOpenTab?: (tab: AppStatusTab) => void}) {
    const {platform} = useDashboardEnvironment();
    if (platform.kind === 'desktop') return <ConnectedDesktopStatus onOpenTab={onOpenTab} />;
    if (platform.accountAuthentication.kind === 'cookie') {
        return <ConnectedPwaStatus onOpenTab={onOpenTab} />;
    }
    return (
        <AppStatusPanel
            input={{
                surface: 'web',
                installSupported: platform.capabilities.pwaInstall && platform.pwa.available,
                installed: platform.pwa.installed,
            }}
            onOpenTab={onOpenTab}
        />
    );
}
