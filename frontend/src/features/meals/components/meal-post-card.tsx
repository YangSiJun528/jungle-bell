import {Clock3, ExternalLink, ImageOff} from 'lucide-react';
import {useState} from 'react';

import type {DashboardMealPost} from '@/api/dashboard-api';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {dateTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';

import type {TodayMealPeriod} from '../lib/meal-view';

function MealImage({
    compact,
    eager,
    image,
    label,
}: {
    compact: boolean;
    eager: boolean;
    image: NonNullable<DashboardMealPost['images']>[number];
    label: string;
}) {
    const [failed, setFailed] = useState(false);

    if (failed) {
        return (
            <div
                aria-label={`${label} 이미지 불러오기 실패`}
                className={cn(
                    'flex aspect-[4/3] size-full items-center justify-center bg-muted text-muted-foreground',
                    compact && 'max-h-64',
                )}
                role="img"
            >
                <ImageOff aria-hidden="true" className="size-6" />
            </div>
        );
    }

    return (
        <a
            aria-label={`${label} 새 탭에서 열기`}
            className="block focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            href={image.url}
            rel="noopener noreferrer"
            target="_blank"
        >
            <img
                alt={label}
                className={cn(
                    'aspect-[4/3] size-full bg-muted object-cover',
                    compact && 'max-h-64',
                )}
                decoding="async"
                height={image.height ?? undefined}
                loading={eager ? 'eager' : 'lazy'}
                src={image.url}
                width={image.width ?? undefined}
                onError={() => setFailed(true)}
            />
        </a>
    );
}

export function MealPostCard({
    compact = false,
    eagerImage = false,
    meal,
}: {
    compact?: boolean;
    eagerImage?: boolean;
    meal: DashboardMealPost;
}) {
    const images = meal.images ?? [];
    const title = meal.title ?? '\uC2DD\uB2E8 \uC548\uB0B4';
    const text = meal.text.trim();
    return (
        <Card
            className={cn('overflow-hidden py-0 shadow-none', compact && 'gap-4')}
            data-meal-state="available"
        >
            {images.length > 0 ? (
                <div className={cn('grid gap-px bg-border', images.length > 1 && 'grid-cols-2')}>
                    {images.map((image, index) => (
                        <MealImage
                            compact={compact}
                            eager={eagerImage && index === 0}
                            image={image}
                            key={image.sha}
                            label={`${title} \uC0AC\uC9C4${images.length > 1 ? ` ${index + 1}` : ''}`}
                        />
                    ))}
                </div>
            ) : (
                <div
                    aria-label={`${title} \uC0AC\uC9C4 \uC5C6\uC74C`}
                    className="flex aspect-[4/3] items-center justify-center border-b bg-muted/60 px-5 text-center text-xs text-muted-foreground"
                    role="img"
                >
                    급식 사진이 아직 올라오지 않았습니다.
                </div>
            )}
            <CardHeader className="px-5 pt-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle className="line-clamp-2 text-base leading-6">{title}</CardTitle>
                        <CardDescription className="mt-1">
                            {dateTimeLabel(meal.publishedAt)}
                        </CardDescription>
                    </div>
                    {meal.permalink ? (
                        <Button asChild size="icon-sm" variant="ghost">
                            <a
                                aria-label="식단 원문 열기"
                                href={meal.permalink}
                                rel="noreferrer"
                                target="_blank"
                            >
                                <ExternalLink />
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
                {text ? (
                    <p
                        className={cn(
                            'text-sm leading-6 whitespace-pre-wrap text-foreground/85',
                            compact && 'line-clamp-5',
                        )}
                    >
                        {text}
                    </p>
                ) : (
                    <p className="rounded-md bg-muted/60 p-3 text-sm leading-6 text-muted-foreground">
                        메뉴가 아직 올라오지 않았습니다.
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

export function MissingMealPostCard({period}: {period: TodayMealPeriod}) {
    return (
        <Card className="gap-0 overflow-hidden py-0 shadow-none" data-meal-state="missing">
            <div
                aria-label={`${period} \uC2DD\uB2E8 \uAC8C\uC2DC \uB300\uAE30`}
                className="flex aspect-[4/3] items-center justify-center border-b bg-muted/60 text-muted-foreground"
                role="img"
            >
                <Clock3 aria-hidden="true" className="size-6" />
            </div>
            <CardHeader className="p-5">
                <CardTitle className="text-base leading-6">{period}</CardTitle>
                <CardDescription className="mt-1">아직 올라오지 않았습니다.</CardDescription>
            </CardHeader>
        </Card>
    );
}
