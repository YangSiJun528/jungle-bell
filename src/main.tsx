import React from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core';
import {neutralTheme} from '@astryxdesign/theme-neutral';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';
import {App} from './App';
import {installFrontendDiagnostics, logFromFrontend} from './tauri';

installFrontendDiagnostics('settings');
createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Theme theme={neutralTheme}>
      <App />
    </Theme>
  </React.StrictMode>,
);
logFromFrontend('info', '[settings] react render scheduled');
