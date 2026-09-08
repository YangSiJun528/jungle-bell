import type {PropsWithChildren} from 'react';

import {useDashboardAccount} from './dashboard-account';
import type {PersonalAccessStatus} from './dashboard-account-state';

export function personalFeatureAvailable(access: {status: PersonalAccessStatus}): boolean {
    return access.status === 'connected';
}

export function PersonalFeatureSlot({children}: PropsWithChildren) {
    const {personalAccess} = useDashboardAccount();
    return personalAccess.status === 'connected' ? children : null;
}
