export type InstallStepId = 'pc' | 'pairing' | 'pwa' | 'push';

const DESKTOP_INSTALL_STEP_ORDER: readonly InstallStepId[] = ['pc', 'pairing', 'pwa', 'push'];
const MOBILE_INSTALL_STEP_ORDER: readonly InstallStepId[] = ['pwa', 'pc', 'pairing', 'push'];

export function installStepOrder(mobileClient: boolean): readonly InstallStepId[] {
    return mobileClient ? MOBILE_INSTALL_STEP_ORDER : DESKTOP_INSTALL_STEP_ORDER;
}
