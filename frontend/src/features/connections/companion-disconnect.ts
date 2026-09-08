export interface CompanionPushCleanupOutcome {
    status: 'complete' | 'incomplete' | 'not-verified';
    reason?: string;
}

export interface UnexpectedPushCleanupFailure extends CompanionPushCleanupOutcome {
    status: 'incomplete';
    reason: 'cleanup-failed';
    error: unknown;
}

type NormalizedPushCleanup<TCleanup extends CompanionPushCleanupOutcome> =
    | TCleanup
    | UnexpectedPushCleanupFailure;

export type CompanionDisconnectOutcome<TCleanup extends CompanionPushCleanupOutcome> =
    | {session: 'disconnected'; pushCleanup: NormalizedPushCleanup<TCleanup>}
    | {
          session: 'connected';
          pushCleanup: NormalizedPushCleanup<TCleanup>;
          error: unknown;
      };

interface CompanionDisconnectOptions<TCleanup extends CompanionPushCleanupOutcome> {
    cleanupPush: () => Promise<TCleanup>;
    disconnectSession: () => Promise<void>;
    previousCleanup?: TCleanup;
}

export async function disconnectCompanionWithPushCleanup<
    TCleanup extends CompanionPushCleanupOutcome,
>({
    cleanupPush,
    disconnectSession,
    previousCleanup,
}: CompanionDisconnectOptions<TCleanup>): Promise<CompanionDisconnectOutcome<TCleanup>> {
    let pushCleanup: NormalizedPushCleanup<TCleanup>;
    try {
        pushCleanup =
            previousCleanup?.status === 'complete' ? previousCleanup : await cleanupPush();
    } catch (error) {
        pushCleanup = {
            status: 'incomplete',
            reason: 'cleanup-failed',
            error,
        };
    }

    try {
        await disconnectSession();
        return {session: 'disconnected', pushCleanup};
    } catch (error) {
        return {session: 'connected', pushCleanup, error};
    }
}
