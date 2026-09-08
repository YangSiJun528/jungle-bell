export interface ExclusiveActionGate {
    inFlight: boolean;
}

export function tryReserveExclusiveAction(gate: ExclusiveActionGate): boolean {
    if (gate.inFlight) return false;
    gate.inFlight = true;
    return true;
}

export function releaseExclusiveAction(gate: ExclusiveActionGate): void {
    gate.inFlight = false;
}
