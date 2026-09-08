import {CalendarDays, RefreshCw, Utensils} from 'lucide-react';
import {type ReactNode, useMemo} from 'react';

import {type DashboardMealPost, type DashboardMealsSnapshot} from '@/api/dashboard-api';
import {useCampusManualRefresh, useSuspenseMealsQuery} from '@/app/use-dashboard-queries';
import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {
    AsyncState,
    EmptyState,
    LoadingState,
    useOnlineStatus,
} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';
import {selectTodayMeals} from '@/domain/meals/today';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';

import {MealHistorySection} from '../components/meal-history-section';
import {TodayMealGrid} from '../components/today-meal-grid';
import {WeeklyMealMenu} from '../components/weekly-meal-menu';
import {
    mealsPageLoadState,
    type MealsPageLoadState,
    type MealsPageSectionState,
} from '../lib/meal-view';

type MealsPageSections = MealsPageSectionState;

export type MealsPageBoundaryResult = {
    state: MealsPageLoadState;
    meals: ReturnType<typeof useSuspenseMealsQuery>;
    sections: MealsPageSections;
    todayMeals: DashboardMealPost[];
    weeklyMeal: NonNullable<DashboardMealsSnapshot['data']['currentWeeklyMenu']>['post'];
    weeklyKey: string | null;
    historyHasContent: boolean;
    manualRefresh: ReturnType<typeof useCampusManualRefresh>;
    isRefreshing: boolean;
};

type MealsPageBoundaryProps = {
    children: (result: MealsPageBoundaryResult) => ReactNode;
    manualRefresh: ReturnType<typeof useCampusManualRefresh>;
};

export interface MealsFeatureBoundaryProps {
    children: ReactNode;
    errorDescription?: string;
    errorTitle?: string;
    fallback?: ReactNode;
    resetKeys?: unknown[];
}

export function MealsFeatureBoundary({
    children,
    errorDescription = '현재 페이지 헤더만 유지된 상태에서 새로고침할 수 있습니다.',
    errorTitle = '급식 정보를 불러오지 못했습니다.',
    fallback = <LoadingState label="급식 정보를 불러오는 중입니다." />,
    resetKeys,
}: MealsFeatureBoundaryProps) {
    const isOnline = useOnlineStatus();

    return (
        <AsyncBoundary
            errorDescription={errorDescription}
            errorTitle={errorTitle}
            fallback={
                isOnline ? (
                    fallback
                ) : (
                    <AsyncState
                        type="offline"
                        title="현재 오프라인 상태입니다."
                        description="저장된 급식 정보가 없어 인터넷 연결 후 다시 확인해야 합니다."
                        reason="네트워크 연결 끊김"
                    />
                )
            }
            regionLabel="급식 데이터"
            renderError={({retry}) =>
                isOnline ? (
                    <AsyncState
                        type="error"
                        title={errorTitle}
                        description={errorDescription}
                        retry={retry}
                        retryLabel="다시 시도"
                    />
                ) : (
                    <AsyncState
                        type="offline"
                        title="현재 오프라인 상태입니다."
                        description="인터넷 연결을 확인한 뒤 다시 시도해 주세요."
                        reason="네트워크 연결 끊김"
                    />
                )
            }
            resetKeys={resetKeys}
        >
            {children}
        </AsyncBoundary>
    );
}

function messageForStatus(state: MealsPageLoadState) {
    if (state.kind === 'offline') {
        return {
            title: '현재 오프라인 상태입니다.',
            description:
                '인터넷 연결이 없어 마지막 정상 급식을 표시합니다. 실시간 정보가 아닙니다.',
            reason: '네트워크 연결 끊김',
        };
    }

    if (state.kind === 'error') {
        return {
            title: '급식 정보를 불러오지 못했습니다.',
            description: '네트워크 또는 서버 오류로 인해 데이터를 표시할 수 없습니다.',
            reason: '급식 조회 실패',
        };
    }

    if (state.kind === 'stale' || state.kind === 'recovered') {
        const recovered = state.kind === 'recovered';
        return {
            title: recovered ? '급식 정보가 복구되었습니다.' : '급식 정보가 최신이 아닙니다.',
            description: recovered
                ? '최근 조회 실패가 해결되어 최신 급식으로 갱신했습니다.'
                : '마지막 정상 급식을 표시합니다. 실시간 정보가 아닙니다.',
            reason: recovered
                ? '정상 조회 재개'
                : state.reason === 'fetch-failed'
                  ? '최신 급식 갱신 실패'
                  : '급식 데이터 갱신 지연',
        };
    }

    return {
        title: '',
        description: '',
        reason: '',
    };
}

function MealsPageStatusBanner({
    state,
    lastCheckedAt,
    isRefreshing,
    onRetry,
}: {
    state: MealsPageLoadState;
    lastCheckedAt: string;
    isRefreshing: boolean;
    onRetry: () => void;
}) {
    if (state.kind === 'normal' || state.kind === 'loading') {
        return null;
    }

    if (state.kind === 'empty') {
        return (
            <AsyncState
                type="empty"
                title="표시할 급식 정보가 없습니다."
                description="새 급식이 등록되면 이 화면에 표시됩니다."
                regionLabel="급식 데이터 상태"
            />
        );
    }

    const statusMessage = messageForStatus(state);

    if (state.kind === 'error') {
        return (
            <AsyncState
                type="error"
                title={statusMessage.title}
                description={statusMessage.description}
                regionLabel="급식 데이터 상태"
                retry={state.canRetry && !isRefreshing ? onRetry : undefined}
            />
        );
    }

    return (
        <AsyncState
            type={state.kind}
            title={statusMessage.title}
            description={statusMessage.description}
            lastUpdatedAt={lastCheckedAt}
            reason={statusMessage.reason}
            regionLabel="급식 데이터 상태"
            retry={state.canRetry && !isRefreshing ? onRetry : undefined}
            retryLabel="새로고침"
        />
    );
}

export function MealsPage() {
    const manualRefresh = useCampusManualRefresh('meals');
    const isOnline = useOnlineStatus();
    const isRefreshing = manualRefresh.isPending;

    return (
        <div className="space-y-6">
            <PageHeader
                title="급식"
                actions={
                    <Button
                        disabled={isRefreshing || !isOnline}
                        variant="outline"
                        onClick={() => manualRefresh.mutate()}
                    >
                        <RefreshCw className={cn(isRefreshing && 'animate-spin')} />
                        {!isOnline ? '오프라인' : isRefreshing ? '새로고침 중' : '새로고침'}
                    </Button>
                }
            />

            <MealsFeatureBoundary
                errorTitle="급식 정보를 불러오지 못했습니다."
                errorDescription="현재 페이지 헤더만 유지된 상태에서 새로고침할 수 있습니다."
            >
                <MealsPageBoundary manualRefresh={manualRefresh}>
                    {({
                        state,
                        meals,
                        todayMeals,
                        weeklyMeal,
                        weeklyKey,
                        historyHasContent,
                        isRefreshing: featureRefreshing,
                    }) => {
                        const lastCheckedLabel = relativeTimeLabel(
                            meals.data.lastCheckedAt ?? meals.data.asOf,
                        );
                        const lastCheckedAt = dateTimeLabel(
                            meals.data.lastCheckedAt ?? meals.data.asOf,
                        );

                        return (
                            <>
                                <MealsPageStatusBanner
                                    isRefreshing={featureRefreshing}
                                    lastCheckedAt={lastCheckedAt}
                                    state={state}
                                    onRetry={() => {
                                        manualRefresh.mutate();
                                    }}
                                />

                                <section aria-labelledby="today-meals-title">
                                    <div className="mb-3">
                                        <h2
                                            className="flex items-center gap-2 font-semibold"
                                            id="today-meals-title"
                                        >
                                            <Utensils className="size-4 text-primary" />
                                            오늘 급식
                                        </h2>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            마지막 확인 {lastCheckedLabel}
                                        </p>
                                    </div>
                                    <TodayMealGrid meals={todayMeals} />
                                </section>

                                <section aria-labelledby="weekly-meal-title">
                                    <h2
                                        className="mb-3 flex items-center gap-2 font-semibold"
                                        id="weekly-meal-title"
                                    >
                                        <CalendarDays className="size-4 text-primary" />
                                        이번 주 급식표
                                    </h2>
                                    {weeklyMeal && weeklyKey ? (
                                        <WeeklyMealMenu meal={weeklyMeal} weekKey={weeklyKey} />
                                    ) : (
                                        <EmptyState
                                            title={
                                                state.sections.weeklyEmpty
                                                    ? '이번 주 급식표가 없습니다.'
                                                    : '이번 주 급식표를 가져오지 못했습니다.'
                                            }
                                            description={
                                                state.kind === 'offline'
                                                    ? '오프라인에서 확인할 수 있는 최근 급식표가 없습니다.'
                                                    : state.kind === 'stale'
                                                      ? '마지막 정상 데이터에도 이번 주 급식표가 없습니다.'
                                                      : '새 급식표가 확인되면 표시됩니다.'
                                            }
                                        />
                                    )}
                                </section>

                                {historyHasContent ? (
                                    <MealHistorySection meals={meals.data} />
                                ) : (
                                    <section aria-labelledby="meal-history-empty-title">
                                        <h2
                                            className="mb-3 flex items-center gap-2 font-semibold"
                                            id="meal-history-empty-title"
                                        >
                                            <CalendarDays className="size-4 text-primary" />
                                            지난 급식 기록
                                        </h2>
                                        <EmptyState
                                            title="지난 급식 기록이 없습니다."
                                            description="아직 저장된 과거 급식 기록이 없습니다."
                                        />
                                    </section>
                                )}
                            </>
                        );
                    }}
                </MealsPageBoundary>
            </MealsFeatureBoundary>
        </div>
    );
}

export function MealsPageBoundary({children, manualRefresh}: MealsPageBoundaryProps) {
    const meals = useSuspenseMealsQuery();
    const isOnline = useOnlineStatus();

    const todayMeals = useMemo(() => selectTodayMeals(meals.data), [meals.data]);
    const currentWeekly = meals.data.data.currentWeeklyMenu;
    const weeklyMeal = currentWeekly?.status === 'AVAILABLE' ? currentWeekly.post : null;
    const weeklyKey = currentWeekly?.targetWeekKey ?? null;
    const sections = {
        todayEmpty: todayMeals.length === 0,
        weeklyEmpty: weeklyMeal === null,
        historyEmpty:
            meals.data.data.dailyMenus.length === 0 &&
            meals.data.data.recentMenus.length === 0 &&
            meals.data.data.weeklyMenus.length === 0,
    };
    const isOffline = !isOnline || meals.fetchStatus === 'paused';
    const isRefreshing = meals.isFetching || manualRefresh.isPending;
    const manualRefreshFailureIsCurrent =
        manualRefresh.isError && manualRefresh.submittedAt >= meals.dataUpdatedAt;
    const recoveredFromManualRefresh =
        manualRefresh.isError &&
        manualRefresh.submittedAt > 0 &&
        meals.dataUpdatedAt > manualRefresh.submittedAt;
    const recovered =
        (recoveredFromManualRefresh ||
            (meals.errorUpdatedAt > 0 && meals.dataUpdatedAt > meals.errorUpdatedAt)) &&
        !meals.isError &&
        !meals.isStale &&
        !manualRefreshFailureIsCurrent;

    const state = mealsPageLoadState({
        hasData: Boolean(meals.data),
        isPending: meals.isPending,
        isStale: meals.isStale,
        isError: meals.isError,
        manualRefreshError: manualRefreshFailureIsCurrent,
        todayHasContent: todayMeals.length > 0,
        weeklyHasContent: weeklyMeal !== null,
        historyHasContent: !sections.historyEmpty,
        isOffline,
        recovered,
    });

    return (
        <>
            {children({
                state,
                meals,
                sections,
                todayMeals,
                weeklyMeal,
                weeklyKey,
                historyHasContent: !sections.historyEmpty,
                manualRefresh,
                isRefreshing,
            })}
        </>
    );
}
