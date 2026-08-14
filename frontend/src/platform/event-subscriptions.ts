import type {PlatformUnlisten} from './contracts';

export interface DesktopSubscriptionRegistry {
    disposed: boolean;
    unlisteners: PlatformUnlisten[];
}

type SubscriptionRegistration = () => Promise<PlatformUnlisten>;

type RegistrationResult =
    | {ok: true; unlisten: PlatformUnlisten}
    | {ok: false; error: unknown};

export function createDesktopSubscriptionRegistry(): DesktopSubscriptionRegistry {
    return {disposed: false, unlisteners: []};
}

export function disposeDesktopSubscriptions(registry: DesktopSubscriptionRegistry): void {
    registry.disposed = true;
    for (const unlisten of registry.unlisteners.splice(0)) unlisten();
}

export async function registerDesktopSubscriptions(
    registry: DesktopSubscriptionRegistry,
    subscriptions: readonly SubscriptionRegistration[],
    afterRegistered?: () => Promise<unknown>,
): Promise<void> {
    const results: RegistrationResult[] = await Promise.all(subscriptions.map(async (subscribe) => {
        try {
            return {ok: true, unlisten: await subscribe()};
        } catch (error) {
            return {ok: false, error};
        }
    }));
    const unlisteners = results.flatMap((result) => result.ok ? [result.unlisten] : []);
    const failure = results.find((result) => !result.ok);

    if (registry.disposed || failure) {
        for (const unlisten of unlisteners) unlisten();
        if (failure) throw failure.error;
        return;
    }

    registry.unlisteners.push(...unlisteners);
    if (!registry.disposed) await afterRegistered?.();
}
