/**
 * Crockford Base32 permits O/I/L as human input aliases for 0/1. U is not in
 * the alphabet and deliberately remains unchanged so validation can reject it.
 */
export function normalizeManualPairingCode(value: string): string {
    return value
        .toUpperCase()
        .replace(/[\s-]+/gu, '')
        .replace(/O/gu, '0')
        .replace(/[IL]/gu, '1');
}

export function validManualPairingCode(value: string): boolean {
    return /^[0-9A-HJKMNP-TV-Z]{10}$/u.test(normalizeManualPairingCode(value));
}

export function formatManualPairingCode(value: string): string {
    const normalized = normalizeManualPairingCode(value).slice(0, 10);
    return normalized.length > 5
        ? `${normalized.slice(0, 5)}-${normalized.slice(5)}`
        : normalized;
}
