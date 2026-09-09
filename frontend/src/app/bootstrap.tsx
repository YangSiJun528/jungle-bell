import {RouterProvider} from '@tanstack/react-router';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {captureInitialPairingFromWindow} from '@/app/pairing-bootstrap';
import type {PlatformAdapter} from '@/platform/contracts';
import {createPwaUpdateBootstrap} from '@/platform/pwa/update-bootstrap';

import {DashboardProviders} from './dashboard-providers';
import {createDashboardRouter} from './dashboard-router';
import {DashboardExternalLinkController} from './external-link-controller';
import {PwaUpdateController} from './pwa-update-controller';
import {normalizeLegacyDashboardHash} from './routes';

import './styles/globals.css';

export function bootstrapDashboard(platform: PlatformAdapter): void {
    captureInitialPairingFromWindow(
        platform.accountAuthentication.kind,
        platform.pwa.isMobileInstallClient(),
    );
    const normalizedHash = normalizeLegacyDashboardHash(window.location.hash);
    if (normalizedHash) {
        window.history.replaceState(
            window.history.state,
            '',
            `${window.location.pathname}${window.location.search}${normalizedHash}`,
        );
    }
    const registrationReady = platform.pwa.registerServiceWorker();
    const pwaUpdate = createPwaUpdateBootstrap({
        enabled: import.meta.env.PROD && platform.kind === 'browser',
        serviceWorker: platform.pwa.getServiceWorkerContainer(),
        registrationReady,
        retryRegistration: () => platform.pwa.registerServiceWorker(),
        reloadPage: () => window.location.reload(),
    });
    const router = createDashboardRouter();

    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => document.documentElement.classList.toggle('dark', theme.matches);
    syncTheme();
    theme.addEventListener('change', syncTheme);

    const root = document.getElementById('root');
    if (!root) throw new Error('DASHBOARD_ROOT_MISSING');

    createRoot(root).render(
        <StrictMode>
            <DashboardExternalLinkController platform={platform}>
                <PwaUpdateController bootstrap={pwaUpdate}>
                    <DashboardProviders platform={platform}>
                        <RouterProvider router={router} />
                    </DashboardProviders>
                </PwaUpdateController>
            </DashboardExternalLinkController>
        </StrictMode>,
    );
}
