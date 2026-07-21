export interface MealDisplayPost {
    title?: string;
}

function mealPeriodOrder(title?: string): number {
    if (title?.includes('중식')) return 0;
    if (title?.includes('석식')) return 1;
    return 2;
}

export function sortMealPostsByPeriod<T extends MealDisplayPost>(posts: readonly T[]): T[] {
    return [...posts].sort((left, right) => mealPeriodOrder(left.title) - mealPeriodOrder(right.title));
}
