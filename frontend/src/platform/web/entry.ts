import {bootstrapDashboard} from '@/app/bootstrap';
import {createPwaCapabilityAdapter} from '@/platform/pwa/adapter';
import {createWebPlatformAdapter} from './adapter';

export function startWebApp(): void {
    const pwa = createPwaCapabilityAdapter({production: import.meta.env.PROD});
    bootstrapDashboard(createWebPlatformAdapter(pwa));
}
