import {useEffect, useEffectEvent} from 'react';

import {pwaReloadPreservers, type PwaReloadPreserver} from '@/platform/pwa-reload-preservation';

export function usePwaReloadPreserver(preserver: PwaReloadPreserver): void {
    const preserveLatest = useEffectEvent(preserver);
    useEffect(() => pwaReloadPreservers.register(() => preserveLatest()), []);
}
