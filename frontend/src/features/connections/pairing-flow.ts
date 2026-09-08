import type {DashboardReturnTarget} from '@/app/routes';

export interface PairingCompletionOptions {
    pairingId: string;
    complete(pairingId: string): Promise<'waiting' | 'completed'>;
    pause(milliseconds: number): Promise<void>;
    maximumAttempts?: number;
    signal?: AbortSignal;
}

export type AccountInitializationState =
    | 'not-applicable'
    | 'checking'
    | 'error'
    | 'unconnected'
    | 'connected';
export type AutomaticPairingAction = 'wait' | 'none' | 'clear' | 'resume' | 'qr' | 'handoff';

export interface PairingStartGate {
    inFlight: boolean;
    automaticHandled: boolean;
}

export type CompanionCompletionPath = '/connections' | DashboardReturnTarget | null;

export async function finishCompanionPairing(options: {
    completionPath: CompanionCompletionPath;
    navigate(path: Exclude<CompanionCompletionPath, null>): Promise<unknown>;
    refreshSession(): Promise<unknown>;
}): Promise<void> {
    if (options.completionPath) await options.navigate(options.completionPath);
    await options.refreshSession();
}

export function tryReservePairingStart(gate: PairingStartGate): boolean {
    if (gate.inFlight) return false;
    gate.inFlight = true;
    gate.automaticHandled = true;
    return true;
}

export function releasePairingStart(gate: PairingStartGate): void {
    gate.inFlight = false;
}

export function automaticPairingAction(input: {
    account: AccountInitializationState;
    alreadyHandled: boolean;
    hasRestoredPairing: boolean;
    hasQrLink: boolean;
    canClaimHandoff: boolean;
}): AutomaticPairingAction {
    if (input.alreadyHandled) return 'none';
    if (input.account === 'connected') return 'clear';
    if (input.account !== 'unconnected') return 'wait';
    if (input.hasRestoredPairing) return 'resume';
    if (input.hasQrLink) return 'qr';
    return input.canClaimHandoff ? 'handoff' : 'none';
}

export function pairingCompletionErrorIsTerminal(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return /EXPIRED|NOT_FOUND|CLAIM|ALREADY_USED|RECEIPT_(?:INVALID|MISSING)/u.test(message);
}

function throwIfPairingCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error('PAIRING_CANCELLED');
}

export async function waitForPairingCompletion(options: PairingCompletionOptions): Promise<void> {
    const maximumAttempts = options.maximumAttempts ?? 600;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        throwIfPairingCancelled(options.signal);
        try {
            const result = await options.complete(options.pairingId);
            throwIfPairingCancelled(options.signal);
            if (result === 'completed') return;
            await options.pause(1_000);
            throwIfPairingCancelled(options.signal);
        } catch (error) {
            throwIfPairingCancelled(options.signal);
            if (pairingCompletionErrorIsTerminal(error)) throw error;
            await options.pause(3_000);
            throwIfPairingCancelled(options.signal);
        }
    }
    throw new Error('PAIRING_EXPIRED');
}
