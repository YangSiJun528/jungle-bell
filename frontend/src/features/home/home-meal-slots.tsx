import type {HomeMealSlots} from './home-view-model';

export function HomeMealSlotsList({slots}: {slots: HomeMealSlots}) {
    return (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label="오늘 중식과 석식">
            {slots.map(({period, meal}) => (
                <li
                    data-meal-empty={meal === null}
                    data-meal-period={period}
                    data-meal-state={meal ? 'published' : 'empty'}
                    className={meal
                        ? 'grid min-h-14 grid-cols-[3rem_1fr] items-center gap-3 px-3 py-2 text-sm text-foreground'
                        : 'grid min-h-14 grid-cols-[3rem_1fr] items-center gap-3 bg-muted/40 px-3 py-2 text-sm text-muted-foreground'}
                    key={period}
                >
                    <strong className="text-primary">{period}</strong>
                    {meal ? (
                        <span className="line-clamp-2 whitespace-pre-line font-medium text-foreground">
                            {meal.text || meal.title || '메뉴 준비 중'}
                        </span>
                    ) : (
                        <span className="text-muted-foreground">
                            아직 올라오지 않았습니다
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
