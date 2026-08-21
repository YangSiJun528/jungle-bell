import {useEffect, useState} from 'react';

import {pairingRemainingLabel} from './lib/pairing-expiry';

export function PairingExpiryCountdown({expiresAt}: {expiresAt: string}) {
    const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNowEpochMs(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, []);

    return (
        <span aria-live="polite" className="text-xs text-muted-foreground">
            {pairingRemainingLabel(expiresAt, nowEpochMs)}
        </span>
    );
}
