export interface PairingFragment {
  pairingId: string;
  challenge: string;
}

const PAIRING_ID = /^(?:p|jbc)_[A-Za-z0-9_-]{3,64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/;

export function parsePairingFragment(fragment: string): PairingFragment | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const params = new URLSearchParams(raw);
  const pairingId = params.get("pairing");
  const challenge = params.get("challenge");

  if (
    pairingId === null ||
    challenge === null ||
    !PAIRING_ID.test(pairingId) ||
    !CHALLENGE.test(challenge)
  ) {
    return null;
  }

  return { pairingId, challenge };
}

export function clearPairingFragment(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
