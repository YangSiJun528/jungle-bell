import type {PropsWithChildren} from 'react';

import {PlatformAuthenticationGate} from './platform-authentication-gate';

export function PersonalAccountGate({children}: PropsWithChildren) {
    return <PlatformAuthenticationGate>{children}</PlatformAuthenticationGate>;
}
