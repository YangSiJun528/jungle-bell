import {useMemo} from 'react';
import {
    CalendarDays,
    CircleAlert,
    RefreshCw,
    Utensils,
} from 'lucide-react';
import {useCampusManualRefresh, useMealsQuery} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {selectTodayMeals} from '@/domain/meals/today';
import {relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';
import {MealHistorySection} from '../components/meal-history-section';
import {TodayMealGrid} from '../components/today-meal-grid';
import {WeeklyMealMenu} from '../components/weekly-meal-menu';

export function MealsPage() {
    const meals = useMealsQuery();
    const manualRefresh = useCampusManualRefresh('meals');
    const todayMeals = useMemo(
        () => meals.data ? selectTodayMeals(meals.data) : [],
        [meals.data, meals.dataUpdatedAt],
    );
    const currentWeekly = meals.data?.data.currentWeeklyMenu;
    const weeklyMeal = currentWeekly?.status === 'AVAILABLE' ? currentWeekly.post : null;
    const weeklyKey = currentWeekly?.targetWeekKey ?? null;
    const refreshFailed = meals.isError || manualRefresh.isError;
    const refreshing = meals.isFetching || manualRefresh.isPending;

    return (
        <div className="space-y-6">
            <PageHeader
                title="급식"
                actions={(
                    <Button
                        disabled={refreshing}
                        variant="outline"
                        onClick={() => manualRefresh.mutate()}
                    >
                        <RefreshCw className={cn(refreshing && 'animate-spin')}/>
                        {refreshing ? '새로고침 중' : '새로고침'}
                    </Button>
                )}
            />

            {meals.isPending && !meals.data ? (
                <LoadingState label="급식 정보 확인 중"/>
            ) : meals.isError && !meals.data ? (
                <ErrorState title="급식 정보를 불러오지 못했습니다." retry={() => manualRefresh.mutate()}/>
            ) : meals.data ? (
                <>
                    {refreshFailed ? (
                        <Alert variant="destructive">
                            <CircleAlert/>
                            <AlertTitle>최신 식단을 불러오지 못했습니다.</AlertTitle>
                            <AlertDescription>마지막으로 확인한 게시 정보를 표시합니다.</AlertDescription>
                        </Alert>
                    ) : null}

                    <section aria-labelledby="today-meals-title">
                        <div className="mb-3">
                            <h2 className="flex items-center gap-2 font-semibold" id="today-meals-title">
                                <Utensils className="size-4 text-primary"/>
                                오늘 식단
                            </h2>
                            <p className="mt-1 text-xs text-muted-foreground">
                                마지막 확인 {relativeTimeLabel(meals.data.lastCheckedAt ?? meals.data.asOf)}
                            </p>
                        </div>
                        <TodayMealGrid meals={todayMeals}/>
                    </section>

                    <section aria-labelledby="weekly-meal-title">
                        <h2 className="mb-3 flex items-center gap-2 font-semibold" id="weekly-meal-title">
                            <CalendarDays className="size-4 text-primary"/>
                            이번 주 급식표
                        </h2>
                        {weeklyMeal && weeklyKey ? (
                            <WeeklyMealMenu meal={weeklyMeal} weekKey={weeklyKey}/>
                        ) : (
                            <EmptyState
                                title="이번 주 급식표 없음"
                                description="새 급식표가 확인되면 표시합니다."
                            />
                        )}
                    </section>

                    <MealHistorySection meals={meals.data}/>
                </>
            ) : null}
        </div>
    );
}
