import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {DashboardApp} from './dashboard-app';
import {DashboardProviders} from './dashboard-providers';
import {captureInitialPairingFromWindow} from '@/app/pairing-bootstrap';
import type {PlatformAdapter} from '@/platform/contracts';
import './styles/globals.css';

export function bootstrapDashboard(platform: PlatformAdapter): void {
    captureInitialPairingFromWindow(platform.kind);
    platform.pwa.registerServiceWorker();

    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => document.documentElement.classList.toggle('dark', theme.matches);
    syncTheme();
    theme.addEventListener('change', syncTheme);

    const root = document.getElementById('root');
    if (!root) throw new Error('DASHBOARD_ROOT_MISSING');

    createRoot(root).render(
        <StrictMode>
            <DashboardProviders platform={platform}>
                <DashboardApp/>
            </DashboardProviders>
        </StrictMode>,
    );
}
