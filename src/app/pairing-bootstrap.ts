import type {DashboardSurfaceKind} from '@/app/surface';
import {mobilePairingLinkFromHash, type MobilePairingLink} from '@/domain/connections/pairing-link';

export type InitialPairingEntry =
    | {kind: 'companion'; link: MobilePairingLink}
    | {kind: 'public-install-required'}
    | null;

interface InitialPairingInput {
    hash: string;
    surface: DashboardSurfaceKind;
    pathname: string;
    search: string;
    historyState: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

let initialPairingEntry: InitialPairingEntry = null;

/**
 * Captures a QR fragment before React mounts, then removes the one-time secret
 * from browser history. Public web only keeps an install-required signal.
 */
export function parseAndScrubInitialPairing(input: InitialPairingInput): InitialPairingEntry {
    const link = mobilePairingLinkFromHash(input.hash);
    if (!link) return null;

    const nextHash = input.surface === 'companion' ? '#connections' : '#home';
    input.replaceState(input.historyState, '', `${input.pathname}${input.search}${nextHash}`);

    if (input.surface === 'companion') return {kind: 'companion', link};
    if (input.surface === 'public') return {kind: 'public-install-required'};
    return null;
}

export function captureInitialPairingFromWindow(surface: DashboardSurfaceKind): void {
    initialPairingEntry = parseAndScrubInitialPairing({
        hash: window.location.hash,
        surface,
        pathname: window.location.pathname,
        search: window.location.search,
        historyState: window.history.state,
        replaceState: window.history.replaceState.bind(window.history),
    });
}

export function readInitialPairingEntry(): InitialPairingEntry {
    return initialPairingEntry;
}
