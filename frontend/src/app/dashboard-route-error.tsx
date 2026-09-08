import {ErrorState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';

import type {DashboardContentRoute} from './notification-panel-route';
import {DASHBOARD_ROUTE_META} from './routes';

export function DashboardRouteErrorFallback({
    retry,
    route,
}: {
    retry: () => void;
    route: DashboardContentRoute;
}) {
    const label = DASHBOARD_ROUTE_META[route].label;
    return (
        <div className="space-y-6">
            <PageHeader title={label} />
            <ErrorState title={`${label} 화면을 불러오지 못했습니다.`} retry={retry} />
        </div>
    );
}
