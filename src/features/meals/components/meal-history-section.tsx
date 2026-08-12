import {useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {CalendarDays} from 'lucide-react';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {EmptyState} from '@/components/dashboard/async-state';
import {Card} from '@/components/ui/card';
import type {DashboardMealPost, DashboardMealsSnapshot} from '@/api/dashboard-api';
import {kstDateKey} from '@/domain/meals/today';
import {MealHistoryCalendar} from './meal-history-calendar';
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
    const initialHistory = useMemo(
        () => [...meals.data.dailyMenus, ...meals.data.recentMenus],
        [meals.data.dailyMenus, meals.data.recentMenus],
    );
    const initialHistoryByDate = useMemo(() => mealsGroupedByDate(initialHistory), [initialHistory]);
    const initialDates = useMemo(
        () => [...initialHistoryByDate.keys()].sort((left, right) => right.localeCompare(left)),
        [initialHistoryByDate],
    );
    const [visibleMonthKey, setVisibleMonthKey] = useState(
        () => initialDates[0]?.slice(0, 7) ?? kstDateKey(new Date()).slice(0, 7),
    );
    const monthlyHistory = useQuery({
        queryKey: ['campus', 'meals', 'history', visibleMonthKey],
        queryFn: () => api.getPublicMealHistoryMonth(visibleMonthKey),
        staleTime: 5 * 60_000,
    });
    const historyMeals = useMemo(() => {
        const additional = monthlyHistory.data?.posts ?? [];
        const unique = new Map<string, DashboardMealPost>();
        for (const meal of [...initialHistory, ...additional]) {
            if (!unique.has(meal.id)) unique.set(meal.id, meal);
        }
        return [...unique.values()];
    }, [initialHistory, monthlyHistory.data]);
    const historyByDate = useMemo(() => mealsGroupedByDate(historyMeals), [historyMeals]);
    const historyDates = useMemo(() => {
        const todayKey = kstDateKey(new Date());
        return [...historyByDate.keys()]
            .filter((date) => date < todayKey)
            .sort((left, right) => right.localeCompare(left));
    }, [historyByDate]);
    const availableDates = useMemo(() => new Set(historyDates), [historyDates]);
    const visibleHistoryDates = historyDates.filter((date) => date.startsWith(`${visibleMonthKey}-`));
    const activeHistoryDate = selectedHistoryDate
        && selectedHistoryDate.startsWith(`${visibleMonthKey}-`)
        && historyByDate.has(selectedHistoryDate)
        ? selectedHistoryDate
        : visibleHistoryDates[0] ?? '';
    const activeHistoryMeals = activeHistoryDate ? historyByDate.get(activeHistoryDate) ?? [] : [];
    const activeWeeklyMenu = activeHistoryDate
        ? weeklyMenuForDate(meals.data.weeklyMenus, activeHistoryDate)
        : null;

    return (
        <section aria-labelledby="meal-history-title">
            <h2 className="mb-3 flex items-center gap-2 font-semibold" id="meal-history-title">
                <CalendarDays className="size-4 text-primary"/>
                지난 급식 기록
            </h2>
            {activeHistoryDate ? (
                <div className="space-y-6">
                    <div
                        className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]"
                        data-meal-history-overview="true"
                    >
                        <Card className="mx-auto w-full max-w-80 gap-4 p-4 shadow-none lg:mx-0">
                            <MealHistoryCalendar
                                availableDates={availableDates}
                                month={visibleMonthKey}
                                selectedDate={activeHistoryDate}
                                onMonthChange={(month) => {
                                    setVisibleMonthKey(month);
                                    setSelectedHistoryDate('');
                                }}
                                onSelect={setSelectedHistoryDate}
                            />
                            {monthlyHistory.isFetching ? (
                                <p className="text-xs text-muted-foreground">급식 기록을 불러오는 중입니다.</p>
                            ) : null}
                            {monthlyHistory.isError ? (
                                <p className="text-xs text-destructive">급식 기록을 불러오지 못했습니다.</p>
                            ) : null}
                        </Card>
                        <section aria-labelledby="selected-history-date-title" className="min-w-0">
                            <h3 className="mb-3 text-sm font-semibold" id="selected-history-date-title">
                                {mealDateLabel(activeHistoryDate)}
                            </h3>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                                {activeHistoryMeals.map((meal) => (
                                    <MealPostCard compact key={meal.id} meal={meal}/>
                                ))}
                            </div>
                        </section>
                    </div>
                    <section
                        aria-labelledby="selected-history-week-title"
                        data-meal-history-weekly="true"
                    >
                        <h3 className="mb-3 text-sm font-semibold" id="selected-history-week-title">
                            선택한 주 급식표
                        </h3>
                        {activeWeeklyMenu ? (
                            <WeeklyMealMenu
                                meal={activeWeeklyMenu.post}
                                showSourceLink={false}
                                weekKey={activeWeeklyMenu.weekKey}
                            />
                        ) : (
                            <EmptyState title="저장된 주간 급식표가 없습니다."/>
                        )}
                    </section>
                </div>
            ) : (
                <div className="space-y-4">
                    <Card className="mx-auto w-full max-w-80 gap-4 p-4 shadow-none">
                        <MealHistoryCalendar
                            availableDates={availableDates}
                            month={visibleMonthKey}
                            selectedDate={`${visibleMonthKey}-01`}
                            onMonthChange={(month) => {
                                setVisibleMonthKey(month);
                                setSelectedHistoryDate('');
                            }}
                            onSelect={setSelectedHistoryDate}
                        />
                    </Card>
                    {monthlyHistory.isFetching ? (
                        <p className="text-center text-sm text-muted-foreground">급식 기록을 불러오는 중입니다.</p>
                    ) : monthlyHistory.isError ? (
                        <p className="text-center text-sm text-destructive">급식 기록을 불러오지 못했습니다.</p>
                    ) : (
                        <EmptyState title="이 달에 저장된 급식 기록이 없습니다."/>
                    )}
                </div>
            )}
        </section>
    );
}
