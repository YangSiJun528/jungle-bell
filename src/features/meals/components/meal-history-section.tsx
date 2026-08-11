import {useMemo, useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {CalendarDays} from 'lucide-react';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {EmptyState} from '@/components/dashboard/async-state';
import {Card} from '@/components/ui/card';
import type {DashboardMealPost, DashboardMealsSnapshot} from '@/api/dashboard-api';
import {kstDateKey} from '@/domain/meals/today';
import {MealHistoryCalendar} from './meal-history-calendar';
import {MealHistoryLoadMore} from './meal-history-load-more';
import {MealPostCard} from './meal-post-card';
import {WeeklyMealMenu} from './weekly-meal-menu';
import {
    mealDateLabel,
    mealsGroupedByDate,
    weeklyMenuForDate,
} from '../lib/meal-view';

export function MealHistorySection({meals}: {meals: DashboardMealsSnapshot}) {
    const {api} = useDashboardEnvironment();
    const [selectedHistoryDate, setSelectedHistoryDate] = useState('');
    const historyCursor = meals.data.historyNextBefore ?? null;
    const olderHistory = useInfiniteQuery({
        queryKey: ['campus', 'meals', 'history', historyCursor],
        queryFn: ({pageParam}) => api.getPublicMealHistory(pageParam, 30),
        initialPageParam: historyCursor,
        getNextPageParam: (page) => page.nextBefore ?? undefined,
        enabled: false,
    });
    const historyMeals = useMemo(() => {
        const initial = [...meals.data.dailyMenus, ...meals.data.recentMenus];
        const additional = olderHistory.data?.pages.flatMap((page) => page.posts) ?? [];
        const unique = new Map<string, DashboardMealPost>();
        for (const meal of [...initial, ...additional]) {
            if (!unique.has(meal.id)) unique.set(meal.id, meal);
        }
        return [...unique.values()];
    }, [meals, olderHistory.data]);
    const historyByDate = useMemo(() => mealsGroupedByDate(historyMeals), [historyMeals]);
    const historyDates = useMemo(() => {
        const todayKey = kstDateKey(new Date());
        return [...historyByDate.keys()]
            .filter((date) => date < todayKey)
            .sort((left, right) => right.localeCompare(left));
    }, [historyByDate]);
    const availableDates = useMemo(() => new Set(historyDates), [historyDates]);
    const activeHistoryDate = selectedHistoryDate && historyByDate.has(selectedHistoryDate)
        ? selectedHistoryDate
        : historyDates[0] ?? '';
    const activeHistoryMeals = activeHistoryDate ? historyByDate.get(activeHistoryDate) ?? [] : [];
    const activeWeeklyMenu = activeHistoryDate
        ? weeklyMenuForDate(meals.data.weeklyMenus ?? [], activeHistoryDate)
        : null;
    const canLoadOlder = historyCursor !== null
        && (olderHistory.data === undefined || olderHistory.hasNextPage);

    return (
        <section aria-labelledby="meal-history-title">
            <h2 className="mb-3 flex items-center gap-2 font-semibold" id="meal-history-title">
                <CalendarDays className="size-4 text-primary"/>
                지난 급식 기록
            </h2>
            {activeHistoryDate ? (
                <div className="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
                    <Card className="gap-4 p-5 shadow-none">
                        <MealHistoryCalendar
                            availableDates={availableDates}
                            key={activeHistoryDate.slice(0, 7)}
                            selectedDate={activeHistoryDate}
                            onSelect={setSelectedHistoryDate}
                        />
                        {canLoadOlder ? (
                            <MealHistoryLoadMore
                                loading={olderHistory.isFetchingNextPage}
                                onLoad={() => void olderHistory.fetchNextPage()}
                            />
                        ) : null}
                        {olderHistory.isError ? (
                            <p className="text-xs text-destructive">이전 기록을 불러오지 못했습니다.</p>
                        ) : null}
                    </Card>
                    <div className="space-y-6">
                        <div>
                            <h3 className="mb-3 text-sm font-semibold">
                                {mealDateLabel(activeHistoryDate)}
                            </h3>
                            <div className="grid gap-4 xl:grid-cols-2">
                                {activeHistoryMeals.map((meal) => (
                                    <MealPostCard compact key={meal.id} meal={meal}/>
                                ))}
                            </div>
                        </div>
                        <section aria-labelledby="selected-history-week-title">
                            <h3 className="mb-3 text-sm font-semibold" id="selected-history-week-title">
                                선택한 주 급식표
                            </h3>
                            {activeWeeklyMenu ? (
                                <WeeklyMealMenu
                                    meal={activeWeeklyMenu.post}
                                    weekKey={activeWeeklyMenu.weekKey}
                                />
                            ) : (
                                <EmptyState title="저장된 주간 급식표가 없습니다."/>
                            )}
                        </section>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <EmptyState title="저장된 지난 급식 기록이 없습니다."/>
                    {canLoadOlder ? (
                        <div className="flex justify-center">
                            <MealHistoryLoadMore
                                loading={olderHistory.isFetchingNextPage}
                                onLoad={() => void olderHistory.fetchNextPage()}
                            />
                        </div>
                    ) : null}
                    {olderHistory.isError ? (
                        <p className="text-center text-xs text-destructive">
                            이전 기록을 불러오지 못했습니다.
                        </p>
                    ) : null}
                </div>
            )}
        </section>
    );
}
