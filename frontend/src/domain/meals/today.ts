const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const TITLED_DATE = /(?:(\d{4})\uB144\s*)?(\d{1,2})\uC6D4\s*(\d{1,2})\uC77C/u;

interface MealRecord {
    [key: string]: unknown;
    id: string;
    title: string | null;
    publishedAt: string | null;
    firstSeenAt?: string | null;
}

interface MealsSnapshot<RecordType extends MealRecord> {
    data: {
        dailyMenus: readonly RecordType[];
        recentMenus: readonly RecordType[];
    };
}

const mealOrder = (title: string | null): number => {
    if (title?.includes('\uC870\uC2DD')) return 0;
    if (title?.includes('\uC911\uC2DD')) return 1;
    if (title?.includes('\uC11D\uC2DD')) return 2;
    return 3;
};

export function mealPeriodLabel(
    title: string | null,
): '\uC870\uC2DD' | '\uC911\uC2DD' | '\uC11D\uC2DD' | '\uC2DD\uB2E8' {
    if (title?.includes('\uC870\uC2DD')) return '\uC870\uC2DD';
    if (title?.includes('\uC911\uC2DD')) return '\uC911\uC2DD';
    if (title?.includes('\uC11D\uC2DD')) return '\uC11D\uC2DD';
    return '\uC2DD\uB2E8';
}

export function kstDateKey(reference: Date): string {
    if (!Number.isFinite(reference.getTime())) throw new Error('INVALID_DATE');
    return new Date(reference.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function mealServiceDate(meal: MealRecord, reference = new Date()): string | null {
    const timestamp = meal.publishedAt ?? meal.firstSeenAt ?? null;
    const anchor = timestamp ? new Date(timestamp) : reference;
    const validAnchor = Number.isFinite(anchor.getTime()) ? anchor : reference;
    const match = meal.title?.match(TITLED_DATE);
    if (match?.[2] && match[3]) {
        const month = Number(match[2]);
        const day = Number(match[3]);
        const anchorYear = Number(kstDateKey(validAnchor).slice(0, 4));
        const years = match[1] ? [Number(match[1])] : [anchorYear, anchorYear - 1, anchorYear + 1];
        const candidates = years
            .map((year) => calendarDateKey(year, month, day))
            .filter((value): value is string => value !== null);
        if (candidates.length > 0) {
            const anchorDay = Date.parse(`${kstDateKey(validAnchor)}T00:00:00.000Z`);
            return candidates.reduce((selected, candidate) =>
                Math.abs(Date.parse(`${candidate}T00:00:00.000Z`) - anchorDay) <
                Math.abs(Date.parse(`${selected}T00:00:00.000Z`) - anchorDay)
                    ? candidate
                    : selected,
            );
        }
    }
    return timestamp && Number.isFinite(new Date(timestamp).getTime())
        ? kstDateKey(new Date(timestamp))
        : null;
}

export function selectTodayMeals<RecordType extends MealRecord>(
    snapshot: MealsSnapshot<RecordType>,
    reference = new Date(),
): RecordType[] {
    const todayKey = kstDateKey(reference);
    const unique = new Map<string, RecordType>();
    for (const meal of [...snapshot.data.dailyMenus, ...snapshot.data.recentMenus]) {
        if (!unique.has(meal.id)) unique.set(meal.id, meal);
    }
    return [...unique.values()]
        .filter((meal) => mealServiceDate(meal, reference) === todayKey)
        .sort((left, right) => mealOrder(left.title) - mealOrder(right.title));
}

function calendarDateKey(year: number, month: number, day: number): string | null {
    const value = new Date(Date.UTC(year, month - 1, day));
    if (
        value.getUTCFullYear() !== year ||
        value.getUTCMonth() !== month - 1 ||
        value.getUTCDate() !== day
    )
        return null;
    return value.toISOString().slice(0, 10);
}
