export const MOBILE_INSTALLATION_KEY = 'jungle-bell:mobile-installation-id';

const MOBILE_INSTALLATION_ID = /^jbmi_[0-9a-f]{32}$/u;

export interface MobileInstallationIdEnvironment {
    read(): string | null;
    write(value: string): void;
    randomBytes(length: number): Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createMobileInstallationIdProvider(
    environment: MobileInstallationIdEnvironment,
): () => string {
    let cached: string | null = null;
    return () => {
        if (cached) return cached;
        try {
            const stored = environment.read();
            if (stored && MOBILE_INSTALLATION_ID.test(stored)) {
                cached = stored;
                return stored;
            }
        } catch {
            // Storage is optional; the module cache keeps this page's pairing stable.
        }

        const bytes = environment.randomBytes(16);
        if (bytes.length !== 16) throw new Error('MOBILE_INSTALLATION_RANDOM_INVALID');
        cached = `jbmi_${bytesToHex(bytes)}`;
        try {
            environment.write(cached);
        } catch {
            // Private browsing can reject a storage write.
        }
        return cached;
    };
}
