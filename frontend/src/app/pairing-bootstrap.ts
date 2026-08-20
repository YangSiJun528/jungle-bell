import type {AccountAuthentication} from '@/platform/contracts';
import {mobilePairingLinkFromHash, type MobilePairingLink} from '@/domain/connections/pairing-link';

export type InitialPairingEntry =
    | {kind: 'companion'; link: MobilePairingLink}
    | null;

interface InitialPairingInput {
    hash: string;
    authentication: AccountAuthentication['kind'];
    mobileInstallClient: boolean;
    pathname: string;
    search: string;
    historyState: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

let initialPairingEntry: InitialPairingEntry = null;

/**
 * Captures a QR fragment before React mounts, then removes the one-time secret
 * from browser history. Browser clients can complete the pairing directly.
 */
export function parseAndScrubInitialPairing(input: InitialPairingInput): InitialPairingEntry {
    const link = mobilePairingLinkFromHash(input.hash);
    if (!link) return null;

    const companion = input.authentication === 'cookie'
        || (input.authentication === 'none' && input.mobileInstallClient);
    const nextHash = companion ? '#/setup' : '#/home';
    input.replaceState(input.historyState, '', `${input.pathname}${input.search}${nextHash}`);

    if (companion) return {kind: 'companion', link};
    return null;
}

export function captureInitialPairingFromWindow(
    authentication: AccountAuthentication['kind'],
    mobileInstallClient: boolean,
): void {
    initialPairingEntry = parseAndScrubInitialPairing({
        hash: window.location.hash,
        authentication,
        mobileInstallClient,
        pathname: window.location.pathname,
        search: window.location.search,
        historyState: window.history.state,
        replaceState: window.history.replaceState.bind(window.history),
    });
}

export function readInitialPairingEntry(): InitialPairingEntry {
    return initialPairingEntry;
}
