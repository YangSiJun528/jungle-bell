import type {PropsWithChildren} from 'react';

import {useDashboardAccount} from '../../state/dashboard-account';
import type {PersonalAccessStatus} from '../../state/dashboard-account-state';

export function personalFeatureAvailable(access: {status: PersonalAccessStatus}): boolean {
    return access.status === 'connected';
}

export function PersonalFeatureSlot({children}: PropsWithChildren) {
    const {personalAccess} = useDashboardAccount();
    return personalAccess.status === 'connected' ? children : null;
}
