import React from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core';
import {neutralTheme} from '@astryxdesign/theme-neutral';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';
import {OnboardingApp} from './OnboardingApp';
import {installFrontendDiagnostics, logFromFrontend} from './tauri';

installFrontendDiagnostics('onboarding');
createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Theme theme={neutralTheme}>
      <OnboardingApp />
    </Theme>
  </React.StrictMode>,
);
logFromFrontend('info', '[onboarding] react render scheduled');
