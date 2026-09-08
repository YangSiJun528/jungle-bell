import {useMutation} from '@tanstack/react-query';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {lazy, useCallback, useEffect, useState} from 'react';

import type {MobilePairingLink} from '@/domain/connections/pairing-link';

import {useDashboardEnvironment} from './dashboard-context';
import {useDashboardRouteRuntime} from './dashboard-route-runtime';
import {clearInitialPairingEntry, readInitialPairingEntry} from './pairing-bootstrap';
import type {ConnectionsTab} from './routes';

const HomePage = lazy(() =>
    import('@/features/home/home-page').then((module) => ({default: module.HomePage})),
);
const AttendancePage = lazy(() =>
    import('@/features/attendance/attendance-page').then((module) => ({
        default: module.AttendancePage,
    })),
);
const LaundryPage = lazy(() =>
    import('@/features/laundry/pages/laundry-page').then((module) => ({
        default: module.LaundryPage,
    })),
);
const MealsPage = lazy(() =>
    import('@/features/meals/pages/meals-page').then((module) => ({default: module.MealsPage})),
);
const ConnectionsPage = lazy(() =>
    import('@/features/connections/connections-page').then((module) => ({
        default: module.ConnectionsPage,
    })),
);
const AppStatusPage = lazy(() =>
    import('@/features/app-status/app-status-page').then((module) => ({
        default: module.AppStatusPage,
    })),
);
const AppInstallPage = lazy(() =>
    import('@/features/app-install/app-install-page').then((module) => ({
        default: module.AppInstallPage,
    })),
);

export function HomeRoutePage() {
    return <HomePage />;
}

export function AppInstallRoutePage() {
    const {openInstallPrompt} = useDashboardRouteRuntime();
    const {api, platform} = useDashboardEnvironment();
    const [initialPairing] = useState(readInitialPairingEntry);
    const handoffLink = initialPairing?.kind === 'install-handoff' ? initialPairing.link : null;
    // This only prepares an HttpOnly cookie; it does not mutate query-backed state.
    // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
    const prepareHandoff = useMutation({
        mutationFn: (input: MobilePairingLink) => api.prepareQrPairingHandoff(input),
        onSuccess: clearInitialPairingEntry,
    });
    const startHandoff = prepareHandoff.mutate;

    useEffect(() => {
        if (handoffLink) startHandoff(handoffLink);
    }, [handoffLink, startHandoff]);

    const canRequestMobileInstall =
        platform.kind === 'browser' &&
        !platform.pwa.installed &&
        platform.pwa.isMobileInstallClient();
    const mobileHandoffStatus = !handoffLink
        ? 'none'
        : prepareHandoff.isError
          ? 'error'
          : prepareHandoff.isSuccess
            ? 'ready'
            : 'preparing';
    return (
        <AppInstallPage
            onRequestMobileInstall={canRequestMobileInstall ? openInstallPrompt : undefined}
            focusMobileInstall={handoffLink !== null}
            mobileHandoffStatus={mobileHandoffStatus}
            onRetryMobileHandoff={
                handoffLink ? () => prepareHandoff.mutate(handoffLink) : undefined
            }
        />
    );
}

export function AttendanceRoutePage() {
    return <AttendancePage />;
}

export function LaundryRoutePage() {
    return <LaundryPage />;
}

export function MealsRoutePage() {
    return <MealsPage />;
}

export function ConnectionsRoutePage() {
    const search = useSearch({from: '/connections'});
    const navigate = useNavigate({from: '/connections'});
    const selectTab = useCallback(
        (tab: ConnectionsTab) => {
            void navigate({search: (previous) => ({...previous, tab})});
        },
        [navigate],
    );

    return (
        <ConnectionsPage
            tab={search.tab}
            returnTo={search.returnTo}
            onTabChange={selectTab}
            renderAppStatus={() => <AppStatusPage onOpenTab={selectTab} />}
        />
    );
}

export function NotificationRoutePage() {
    const {contentRoute} = useDashboardRouteRuntime();
    switch (contentRoute) {
        case 'attendance':
            return <AttendanceRoutePage />;
        case 'laundry':
            return <LaundryRoutePage />;
        case 'meals':
            return <MealsRoutePage />;
        case 'connections':
            return <ConnectionsRoutePage />;
        case 'install':
            return <AppInstallRoutePage />;
        default:
            return <HomeRoutePage />;
    }
}
