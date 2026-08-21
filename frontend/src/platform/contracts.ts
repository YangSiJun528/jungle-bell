export type PlatformKind = 'browser' | 'desktop';

export interface PlatformCapabilities {
    desktopAccount: boolean;
    desktopSettings: boolean;
    laundryRiskIndicator: boolean;
    localNotifications: boolean;
    lmsWindow: boolean;
    mobilePairingManagement: boolean;
    pwaInstall: boolean;
    webPush: boolean;
}

export interface DesktopHttpSessionBootstrap {
    accessToken: string;
    expiresAt: string;
}

export interface AccountSessionLease {
    readonly accessToken: string;
    readonly generation: number;
}

export interface AccountAuthProvider {
    getSessionLease(): Promise<AccountSessionLease>;
    refreshAfterUnauthorized(rejectedLease: AccountSessionLease): Promise<AccountSessionLease>;
    assertCurrent(lease: AccountSessionLease): void;
    clear(): void;
}

export type AccountAuthentication =
    | {kind: 'none'}
    | {kind: 'cookie'}
    | {kind: 'desktop-session'; session: AccountAuthProvider};

export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface NativeBridge {
    bootstrapDesktopHttpSession(): Promise<DesktopHttpSessionBootstrap>;
    getDesktopSettings(): Promise<unknown>;
    updateDesktopSettings(input: unknown): Promise<unknown>;
    checkDesktopUpdate(): Promise<unknown>;
    installDesktopUpdate(): Promise<unknown>;
    openLogFolder(): Promise<unknown>;
    openSystemNotificationSettings(): Promise<unknown>;
    getDesktopConnectionState(): Promise<unknown>;
    resetDesktopIdentity(): Promise<unknown>;
    refreshPlatformSync(): Promise<unknown>;
    openLmsLogin(): Promise<unknown>;
    getNotificationInboxSnapshot(): Promise<unknown>;
    markNotificationRead(id: string): Promise<unknown>;
    markAllNotificationsRead(): Promise<unknown>;
    activateNotification(id: string): Promise<unknown>;
    sendTestNotification(): Promise<unknown>;
}

export interface DesktopCohortOption {
    id: string;
    label: string;
    startDate: string;
    endDate: string | null;
    isActive: boolean;
}

export interface DesktopSettings {
    appVersion: string;
    autoStart: boolean;
    autoUpdate: boolean;
    debugMode: boolean;
    selectedCohortId: string | null;
    effectiveCohortId: string | null;
    cohortOptions: DesktopCohortOption[];
}

export type DesktopSettingsUpdate = Pick<
    DesktopSettings,
    'autoStart' | 'autoUpdate' | 'debugMode' | 'selectedCohortId'
>;

export interface DesktopUpdateStatus {
    currentVersion: string;
    availableVersion: string | null;
    mandatory: boolean;
}

export interface DesktopSettingsAdapter {
    getDesktopSettings(): Promise<DesktopSettings>;
    updateDesktopSettings(input: DesktopSettingsUpdate): Promise<DesktopSettings>;
    checkDesktopUpdate(): Promise<DesktopUpdateStatus>;
    installDesktopUpdate(): Promise<void>;
    openLogFolder(): Promise<void>;
    openSystemNotificationSettings(): Promise<void>;
}

export type PlatformUnlisten = () => void;

export interface PlatformEventAdapter {
    enabled: boolean;
    subscribeNotificationInboxUpdated(
        listener: (payload: unknown) => void,
    ): Promise<PlatformUnlisten>;
    subscribeAttendanceSnapshotUpdated(
        listener: (payload: unknown) => void,
    ): Promise<PlatformUnlisten>;
    subscribeLmsSessionStateUpdated(
        listener: (payload: unknown) => void,
    ): Promise<PlatformUnlisten>;
}

export interface PwaInstallPrompt {
    prompt(): Promise<'accepted' | 'dismissed'>;
}

export interface PwaCapabilityAdapter {
    available: boolean;
    installed: boolean;
    registerServiceWorker(): void;
    preparePush(): Promise<void>;
    subscribeInstallPrompt(listener: (prompt: PwaInstallPrompt) => void): PlatformUnlisten;
    isMobileInstallClient(): boolean;
    subscribePush(applicationServerKey: string): Promise<PushSubscriptionJSON>;
}

export interface PlatformAdapter {
    kind: PlatformKind;
    capabilities: PlatformCapabilities;
    accountAuthentication: AccountAuthentication;
    native: NativeBridge;
    desktopSettings: DesktopSettingsAdapter;
    events: PlatformEventAdapter;
    pwa: PwaCapabilityAdapter;
}

export class PlatformCapabilityUnavailableError extends Error {
    constructor(readonly capability: keyof PlatformCapabilities) {
        super(`PLATFORM_CAPABILITY_UNAVAILABLE:${capability}`);
        this.name = 'PlatformCapabilityUnavailableError';
    }
}

export function unavailablePwaAdapter(): PwaCapabilityAdapter {
    return {
        available: false,
        installed: false,
        registerServiceWorker() {},
        preparePush: async () => {
            throw new PlatformCapabilityUnavailableError('webPush');
        },
        subscribeInstallPrompt: () => () => undefined,
        isMobileInstallClient: () => false,
        subscribePush: async () => {
            throw new PlatformCapabilityUnavailableError('webPush');
        },
    };
}

async function unavailableSubscription(): Promise<PlatformUnlisten> {
    return () => undefined;
}

export function unavailableEventAdapter(): PlatformEventAdapter {
    return {
        enabled: false,
        subscribeNotificationInboxUpdated: unavailableSubscription,
        subscribeAttendanceSnapshotUpdated: unavailableSubscription,
        subscribeLmsSessionStateUpdated: unavailableSubscription,
    };
}
