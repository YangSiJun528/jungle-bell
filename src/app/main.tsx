import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {DashboardApp} from './dashboard-app';
import {DashboardProviders} from './dashboard-providers';
import {resolveDashboardSurface} from '@/dashboard-model';
import {detectDashboardRuntime} from '@/dashboard-runtime';
import {captureInitialPairingFromWindow} from '@/features/connections/pairing-bootstrap';
import './styles/globals.css';

const initialRuntime = detectDashboardRuntime();
captureInitialPairingFromWindow(resolveDashboardSurface(initialRuntime).kind);

const theme = window.matchMedia('(prefers-color-scheme: dark)');
const syncTheme = () => document.documentElement.classList.toggle('dark', theme.matches);
syncTheme();
theme.addEventListener('change', syncTheme);

if (import.meta.env.PROD && !('__TAURI_INTERNALS__' in window) && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Installed updates wait for existing clients to close. The active build's
        // precached lazy chunks must remain available until its React clients exit.
        void navigator.serviceWorker.register('./sw.js', {scope: './'});
    }, {once: true});
}

const root = document.getElementById('root');
if (!root) throw new Error('DASHBOARD_ROOT_MISSING');

createRoot(root).render(
    <StrictMode>
        <DashboardProviders>
            <DashboardApp/>
        </DashboardProviders>
    </StrictMode>,
);
