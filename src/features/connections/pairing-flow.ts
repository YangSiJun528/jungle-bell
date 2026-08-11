export interface PairingCompletionOptions {
    pairingId: string;
    complete(pairingId: string): Promise<'waiting' | 'completed'>;
    pause(milliseconds: number): Promise<void>;
    maximumAttempts?: number;
}

export type AttendanceInitializationState = 'pending' | 'error' | 'auth-required' | 'loaded';
export type AutomaticPairingAction = 'wait' | 'none' | 'clear' | 'resume' | 'qr';

export interface PairingStartGate {
    inFlight: boolean;
    automaticHandled: boolean;
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
    attendance: AttendanceInitializationState;
    alreadyHandled: boolean;
    hasRestoredPairing: boolean;
    hasQrLink: boolean;
}): AutomaticPairingAction {
    if (input.alreadyHandled) return 'none';
    if (input.attendance === 'loaded') return 'clear';
    if (input.attendance !== 'auth-required') return 'wait';
    if (input.hasRestoredPairing) return 'resume';
    return input.hasQrLink ? 'qr' : 'none';
}

export function pairingCompletionErrorIsTerminal(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return /EXPIRED|NOT_FOUND|CLAIM|ALREADY_USED|RECEIPT_(?:INVALID|MISSING)/u.test(message);
}

export async function waitForPairingCompletion(options: PairingCompletionOptions): Promise<void> {
    const maximumAttempts = options.maximumAttempts ?? 120;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        try {
            const result = await options.complete(options.pairingId);
            if (result === 'completed') return;
            await options.pause(1_000);
        } catch (error) {
            if (pairingCompletionErrorIsTerminal(error)) throw error;
            await options.pause(3_000);
        }
    }
    throw new Error('PAIRING_EXPIRED');
}
