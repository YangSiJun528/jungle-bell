export interface InstallClientNavigator {
    userAgent: string;
    platform?: string;
    maxTouchPoints?: number;
}

export function isMobileInstallClient(client: InstallClientNavigator): boolean {
    if (/Android|iPhone|iPad|iPod|Mobile/iu.test(client.userAgent)) return true;
    return client.platform === 'MacIntel' && (client.maxTouchPoints ?? 0) > 1;
}
