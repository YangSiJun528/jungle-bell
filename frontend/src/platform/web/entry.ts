import {bootstrapDashboard} from '@/app/bootstrap';
import {createPwaCapabilityAdapter} from '@/platform/pwa/adapter';

import {createWebPlatformAdapter} from './adapter';
import {createWebUsagePrivacyAdapter} from './usage-preference';
import {startWebUsageReporting} from './usage-reporting';

export function startWebApp(): void {
    const pwa = createPwaCapabilityAdapter({production: import.meta.env.PROD});
    const usagePrivacy = createWebUsagePrivacyAdapter({});
    startWebUsageReporting({
        installedPwa: pwa.installed,
        allowsAnonymousReporting: () => usagePrivacy.allowsAnonymousReporting(),
    });
    bootstrapDashboard(createWebPlatformAdapter(pwa, usagePrivacy));
}
