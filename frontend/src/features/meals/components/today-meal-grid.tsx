import type {DashboardMealPost} from '@/api/dashboard-api';
import {todayMealSlots} from '../lib/meal-view';
import {MealPostCard, MissingMealPostCard} from './meal-post-card';

export function TodayMealGrid({meals}: {meals: readonly DashboardMealPost[]}) {
    const slots = todayMealSlots(meals);

    return (
        <div className="grid gap-4 md:grid-cols-2">
            {slots.map(({period, meal}) => meal ? (
                <MealPostCard eagerImage key={period} meal={meal}/>
            ) : (
                <MissingMealPostCard key={period} period={period}/>
            ))}
        </div>
    );
}
