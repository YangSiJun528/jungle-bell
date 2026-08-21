import {bootstrapDashboard} from '@/app/bootstrap';
import {createPwaCapabilityAdapter} from '@/platform/pwa/adapter';

import {createWebPlatformAdapter} from './adapter';
import {startWebUsageReporting} from './usage-reporting';

export function startWebApp(): void {
    const pwa = createPwaCapabilityAdapter({production: import.meta.env.PROD});
    startWebUsageReporting({installedPwa: pwa.installed});
    bootstrapDashboard(createWebPlatformAdapter(pwa));
}
