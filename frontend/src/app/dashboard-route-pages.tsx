import {lazy} from 'react';
import {useDashboardRouteRuntime} from './dashboard-route-runtime';

const HomePage = lazy(() => import('@/features/home/home-page').then((module) => ({default: module.HomePage})));
const AttendancePage = lazy(() => import('@/features/attendance/attendance-page').then((module) => ({default: module.AttendancePage})));
const LaundryPage = lazy(() => import('@/features/laundry/pages/laundry-page').then((module) => ({default: module.LaundryPage})));
const MealsPage = lazy(() => import('@/features/meals/pages/meals-page').then((module) => ({default: module.MealsPage})));
const ConnectionsPage = lazy(() => import('@/features/connections/connections-page').then((module) => ({default: module.ConnectionsPage})));

export function HomeRoutePage() {
    const {openInstallPrompt} = useDashboardRouteRuntime();
    return <HomePage onRequestInstall={openInstallPrompt}/>;
}

export function AttendanceRoutePage() {
    return <AttendancePage/>;
}

export function LaundryRoutePage() {
    return <LaundryPage/>;
}

export function MealsRoutePage() {
    return <MealsPage/>;
}

export function ConnectionsRoutePage() {
    return <ConnectionsPage/>;
}

export function NotificationRoutePage() {
    const {contentRoute} = useDashboardRouteRuntime();
    switch (contentRoute) {
        case 'attendance': return <AttendanceRoutePage/>;
        case 'laundry': return <LaundryRoutePage/>;
        case 'meals': return <MealsRoutePage/>;
        case 'connections': return <ConnectionsRoutePage/>;
        default: return <HomeRoutePage/>;
    }
}
