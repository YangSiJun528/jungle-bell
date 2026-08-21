import type {PropsWithChildren} from 'react';

import {useDashboardAccount} from './dashboard-account';

export function PersonalFeatureSlot({children}: PropsWithChildren) {
    const {personalAccess} = useDashboardAccount();
    return personalAccess.status === 'connected' ? children : null;
}
