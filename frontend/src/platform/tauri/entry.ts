import {bootstrapDashboard} from '@/app/bootstrap';
import {createTauriPlatformAdapter} from './adapter';

export function startDesktopApp(): void {
    bootstrapDashboard(createTauriPlatformAdapter());
}
