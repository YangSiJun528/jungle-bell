export interface MobilePairingLink {
    pairingId: string;
    challenge: string;
}

export function mobilePairingLinkFromHash(hash: string): MobilePairingLink | null {
    const parameters = new URLSearchParams(hash.replace(/^#/, ''));
    const pairingId = parameters.get('pairing');
    const challenge = parameters.get('challenge');
    return pairingId && challenge ? {pairingId, challenge} : null;
}
