import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from '@tanstack/react-router';
import {DashboardProviders} from './dashboard-providers';
import {captureInitialPairingFromWindow} from '@/app/pairing-bootstrap';
import type {PlatformAdapter} from '@/platform/contracts';
import {createDashboardRouter} from './dashboard-router';
import {normalizeLegacyDashboardHash} from './routes';
import './styles/globals.css';

export function bootstrapDashboard(platform: PlatformAdapter): void {
    captureInitialPairingFromWindow(platform.accountAuthentication.kind);
    const normalizedHash = normalizeLegacyDashboardHash(window.location.hash);
    if (normalizedHash) {
        window.history.replaceState(
            window.history.state,
            '',
            `${window.location.pathname}${window.location.search}${normalizedHash}`,
        );
    }
    platform.pwa.registerServiceWorker();
    const router = createDashboardRouter();

    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => document.documentElement.classList.toggle('dark', theme.matches);
    syncTheme();
    theme.addEventListener('change', syncTheme);

    const root = document.getElementById('root');
    if (!root) throw new Error('DASHBOARD_ROOT_MISSING');

    createRoot(root).render(
        <StrictMode>
            <DashboardProviders platform={platform}>
                <RouterProvider router={router}/>
            </DashboardProviders>
        </StrictMode>,
    );
}
