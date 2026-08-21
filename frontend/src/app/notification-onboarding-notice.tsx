import {useState} from 'react';

import {NotificationOnboardingCard} from '@/features/notifications/notification-delivery-setup';
import type {PlatformAdapter} from '@/platform/contracts';

import {useDashboardAccount} from './dashboard-account';
import {useDashboardEnvironment} from './dashboard-context';
import {
    readNotificationOnboardingDecision,
    type NotificationOnboardingDecision,
    type NotificationOnboardingSurface,
    writeNotificationOnboardingDecision,
} from './notification-onboarding-state';

type NotificationOnboardingDecisions = Record<
    NotificationOnboardingSurface,
    NotificationOnboardingDecision | null
>;

function notificationOnboardingSurface(
    platform: PlatformAdapter,
): NotificationOnboardingSurface | null {
    if (platform.kind === 'desktop' && platform.capabilities.localNotifications) return 'desktop';
    if (platform.kind === 'browser' && platform.pwa.installed && platform.capabilities.webPush)
        return 'pwa';
    return null;
}

function initialDecisions(): NotificationOnboardingDecisions {
    if (typeof window === 'undefined') return {desktop: null, pwa: null};
    return {
        desktop: readNotificationOnboardingDecision(window.localStorage, 'desktop'),
        pwa: readNotificationOnboardingDecision(window.localStorage, 'pwa'),
    };
}

export function NotificationOnboardingNotice() {
    const {platform} = useDashboardEnvironment();
    const {personalAccess} = useDashboardAccount();
    const [decisions, setDecisions] = useState<NotificationOnboardingDecisions>(initialDecisions);
    const surface = notificationOnboardingSurface(platform);

    if (!surface || personalAccess.status !== 'connected' || decisions[surface] !== null)
        return null;

    const decide = (decision: NotificationOnboardingDecision) => {
        writeNotificationOnboardingDecision(window.localStorage, surface, decision);
        setDecisions((current) => ({...current, [surface]: decision}));
    };

    return (
        <NotificationOnboardingCard
            onComplete={() => decide('completed')}
            onSkip={() => decide('dismissed')}
        />
    );
}
