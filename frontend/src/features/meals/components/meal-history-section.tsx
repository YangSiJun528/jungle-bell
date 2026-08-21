import {useSuspenseQuery} from '@tanstack/react-query';
import {CalendarDays} from 'lucide-react';
import {useMemo, useState} from 'react';

import type {DashboardMealPost, DashboardMealsSnapshot} from '@/api/dashboard-api';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {EmptyState, MealHistorySkeleton} from '@/components/dashboard/async-state';
import {Card} from '@/components/ui/card';
import {kstDateKey} from '@/domain/meals/today';

import {mealDateLabel, mealsGroupedByDate, weeklyMenuForDate} from '../lib/meal-view';
import {MealHistoryCalendar} from './meal-history-calendar';
import {MealPostCard} from './meal-post-card';
import {WeeklyMealMenu} from './weekly-meal-menu';

interface MealHistoryMonthProps {
    initialHistory: DashboardMealPost[];
    meals: DashboardMealsSnapshot;
    selectedHistoryDate: string;
    setSelectedHistoryDate: (date: string) => void;
    setVisibleMonthKey: (month: string) => void;
    visibleMonthKey: string;
}

function MealHistoryMonth({
    initialHistory,
    meals,
    selectedHistoryDate,
    setSelectedHistoryDate,
    setVisibleMonthKey,
    visibleMonthKey,
}: MealHistoryMonthProps) {
    const {api} = useDashboardEnvironment();
    const monthlyHistory = useSuspenseQuery({
        queryKey: ['campus', 'meals', 'history', visibleMonthKey],
        queryFn: () => api.getPublicMealHistoryMonth(visibleMonthKey),
        staleTime: 5 * 60_000,
    });
    const historyMeals = useMemo(() => {
        const unique = new Map<string, DashboardMealPost>();
        for (const meal of [...initialHistory, ...monthlyHistory.data.posts]) {
            if (!unique.has(meal.id)) unique.set(meal.id, meal);
        }
        return [...unique.values()];
    }, [initialHistory, monthlyHistory.data.posts]);
    const historyByDate = useMemo(() => mealsGroupedByDate(historyMeals), [historyMeals]);
    const historyDates = useMemo(() => {
        const todayKey = kstDateKey(new Date());
        return [...historyByDate.keys()]
            .filter((date) => date < todayKey)
            .sort((left, right) => right.localeCompare(left));
    }, [historyByDate]);
    const availableDates = useMemo(() => new Set(historyDates), [historyDates]);
    const visibleHistoryDates = historyDates.filter((date) =>
        date.startsWith(`${visibleMonthKey}-`),
    );
    const activeHistoryDate =
        selectedHistoryDate &&
        selectedHistoryDate.startsWith(`${visibleMonthKey}-`) &&
        historyByDate.has(selectedHistoryDate)
            ? selectedHistoryDate
            : (visibleHistoryDates[0] ?? '');
    const activeHistoryMeals = activeHistoryDate
        ? (historyByDate.get(activeHistoryDate) ?? [])
        : [];
    const activeWeeklyMenu = activeHistoryDate
        ? weeklyMenuForDate(meals.data.weeklyMenus, activeHistoryDate)
        : null;
    const changeMonth = (month: string) => {
        setVisibleMonthKey(month);
        setSelectedHistoryDate('');
    };

    return (
        <div className="space-y-6">
            <div
                className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]"
                data-meal-history-overview="true"
            >
                <Card className="mx-auto w-full max-w-80 gap-4 p-4 shadow-none lg:mx-0">
                    <MealHistoryCalendar
                        availableDates={availableDates}
                        month={visibleMonthKey}
                        selectedDate={activeHistoryDate || `${visibleMonthKey}-01`}
                        onMonthChange={changeMonth}
                        onSelect={setSelectedHistoryDate}
                    />
                </Card>
                <section aria-labelledby="selected-history-date-title" className="min-w-0">
                    <h3 className="mb-3 text-sm font-semibold" id="selected-history-date-title">
                        {activeHistoryDate ? mealDateLabel(activeHistoryDate) : '선택한 날짜 식단'}
                    </h3>
                    {activeHistoryMeals.length > 0 ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {activeHistoryMeals.map((meal) => (
                                <MealPostCard compact key={meal.id} meal={meal} />
                            ))}
                        </div>
                    ) : (
                        <EmptyState title="이 달에 저장된 급식 기록이 없습니다." />
                    )}
                </section>
            </div>
            <section aria-labelledby="selected-history-week-title" data-meal-history-weekly="true">
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
                    <EmptyState title="저장된 주간 급식표가 없습니다." />
                )}
            </section>
        </div>
    );
}

export function MealHistorySection({meals}: {meals: DashboardMealsSnapshot}) {
    const [selectedHistoryDate, setSelectedHistoryDate] = useState('');
    const initialHistory = useMemo(
        () => [...meals.data.dailyMenus, ...meals.data.recentMenus],
        [meals.data.dailyMenus, meals.data.recentMenus],
    );
    const initialDates = useMemo(
        () =>
            [...mealsGroupedByDate(initialHistory).keys()].sort((left, right) =>
                right.localeCompare(left),
            ),
        [initialHistory],
    );
    const [visibleMonthKey, setVisibleMonthKey] = useState(
        () => initialDates[0]?.slice(0, 7) ?? kstDateKey(new Date()).slice(0, 7),
    );

    return (
        <section aria-labelledby="meal-history-title">
            <h2 className="mb-3 flex items-center gap-2 font-semibold" id="meal-history-title">
                <CalendarDays className="size-4 text-primary" />
                지난 급식 기록
            </h2>
            <AsyncBoundary
                errorTitle="급식 기록을 불러오지 못했습니다."
                fallback={<MealHistorySkeleton />}
                resetKeys={[visibleMonthKey]}
            >
                <MealHistoryMonth
                    initialHistory={initialHistory}
                    meals={meals}
                    selectedHistoryDate={selectedHistoryDate}
                    setSelectedHistoryDate={setSelectedHistoryDate}
                    setVisibleMonthKey={setVisibleMonthKey}
                    visibleMonthKey={visibleMonthKey}
                />
            </AsyncBoundary>
        </section>
    );
}
