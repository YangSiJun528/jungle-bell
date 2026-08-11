import {useMemo} from 'react';
import {
    CalendarDays,
    CircleAlert,
    RefreshCw,
    Utensils,
} from 'lucide-react';
import {useCampusDataIssue, useDashboardEnvironment} from '@/app/dashboard-context';
import {useCampusManualRefresh, useMealsQuery} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import type {PersonalSurface} from '@/dashboard-personal-api';
import {relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';
import {MealHistorySection} from '../components/meal-history-section';
import {MealPostCard} from '../components/meal-post-card';
import {MealPreferencesSection} from '../components/meal-preferences-section';
import {WeeklyMealMenu} from '../components/weekly-meal-menu';
import {selectMealSections} from '../lib/meal-view';

const personalSurface = (kind: string): PersonalSurface | null =>
    kind === 'desktop' || kind === 'companion' ? kind : null;

export function MealsPage() {
    const {surface} = useDashboardEnvironment();
    const meals = useMealsQuery();
    const manualRefresh = useCampusManualRefresh('meals');
    const campusIssue = useCampusDataIssue('meals');
    const personal = personalSurface(surface.kind);
    const sections = useMemo(
        () => meals.data ? selectMealSections(meals.data) : {today: [], recent: []},
        [meals.data, meals.dataUpdatedAt],
    );
    const currentWeekly = meals.data?.data.currentWeeklyMenu;
    const weeklyMeal = currentWeekly?.status === 'AVAILABLE' ? currentWeekly.post : null;
    const weeklyKey = currentWeekly?.targetWeekKey ?? null;
    const refreshFailed = meals.isError || manualRefresh.isError || campusIssue !== null;
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
                        새로고침
                    </Button>
                )}
            />

            {meals.isPending && !meals.data ? (
                <LoadingState label="급식 정보를 확인하고 있습니다."/>
            ) : meals.isError && !meals.data ? (
                <ErrorState
                    description="급식 게시 정보를 불러오지 못했습니다."
                    retry={() => manualRefresh.mutate()}
                />
            ) : meals.data ? (
                <>
                    {refreshFailed ? (
                        <Alert variant="destructive">
                            <CircleAlert/>
                            <AlertTitle>최신 식단으로 갱신하지 못했습니다.</AlertTitle>
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
                        {sections.today.length > 0 ? (
                            <div className="grid gap-4 lg:grid-cols-2">
                                {sections.today.map((meal, index) => (
                                    <MealPostCard eagerImage={index < 2} key={meal.id} meal={meal}/>
                                ))}
                            </div>
                        ) : (
                            <EmptyState
                                title="오늘 급식이 아직 게시되지 않았습니다."
                                description="게시되면 메뉴와 급식 사진을 함께 표시합니다."
                            />
                        )}
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
                                title="이번 주 급식표를 기다리고 있습니다."
                                description="새 주간 급식표가 확인되면 이곳에 표시됩니다."
                            />
                        )}
                    </section>

                    <MealHistorySection meals={meals.data}/>
                </>
            ) : null}

            {personal ? <MealPreferencesSection surface={personal}/> : null}
        </div>
    );
}
