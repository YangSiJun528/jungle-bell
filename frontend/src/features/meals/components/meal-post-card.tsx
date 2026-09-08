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
    interactive,
    label,
}: {
    compact: boolean;
    eager: boolean;
    image: NonNullable<DashboardMealPost['images']>[number];
    interactive: boolean;
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
            tabIndex={interactive ? undefined : -1}
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
    const title = meal.title ?? '식단 안내';
    const text = meal.text.trim();
    const imageSectionId = `${meal.id}-image-preview`;
    const [isImageExpanded, setIsImageExpanded] = useState(false);

    return (
        <Card
            className={cn('overflow-hidden py-0 shadow-none', compact && 'gap-4')}
            data-meal-state="available"
        >
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
                            'text-base leading-6 whitespace-pre-wrap text-foreground/85',
                            compact && 'line-clamp-5',
                        )}
                    >
                        {text}
                    </p>
                ) : (
                    <p className="rounded-md bg-muted/60 p-3 text-base leading-6 text-muted-foreground">
                        메뉴가 아직 올라오지 않았습니다.
                    </p>
                )}
            </CardContent>
            {images.length > 0 ? (
                <section aria-label={`${title} 이미지`} className="px-5 pb-5">
                    <div
                        aria-hidden={!isImageExpanded}
                        className={cn(
                            'grid gap-px overflow-hidden rounded-lg border bg-border transition-[max-height] duration-200',
                            images.length > 1 && 'grid-cols-2',
                            isImageExpanded ? 'max-h-none' : 'max-h-44',
                        )}
                        id={imageSectionId}
                    >
                        {images.map((image, index) => (
                            <MealImage
                                compact={compact}
                                eager={eagerImage && index === 0}
                                image={image}
                                interactive={isImageExpanded}
                                key={image.sha}
                                label={`${title} 사진${images.length > 1 ? ` ${index + 1}` : ''}`}
                            />
                        ))}
                    </div>
                    <div className="mt-3 min-h-11 w-full">
                        <Button
                            aria-controls={imageSectionId}
                            aria-expanded={isImageExpanded}
                            className="min-h-11 w-full"
                            size="sm"
                            variant="outline"
                            onClick={() => setIsImageExpanded((current) => !current)}
                        >
                            {isImageExpanded ? '이미지 접기' : '이미지 펼치기'}
                        </Button>
                    </div>
                </section>
            ) : (
                <div
                    aria-label={`${title} 사진 없음`}
                    className="flex aspect-[4/3] items-center justify-center border-b bg-muted/60 px-5 text-center text-base leading-6 text-muted-foreground"
                    role="img"
                >
                    급식 사진이 아직 올라오지 않았습니다.
                </div>
            )}
        </Card>
    );
}

export function MissingMealPostCard({period}: {period: TodayMealPeriod}) {
    return (
        <Card className="gap-0 overflow-hidden py-0 shadow-none" data-meal-state="missing">
            <div
                aria-label={`${period} 식단 게시 대기`}
                className="flex aspect-[4/3] items-center justify-center border-b bg-muted/60 text-muted-foreground"
                role="img"
            >
                <Clock3 aria-hidden="true" className="size-6" />
            </div>
            <CardHeader className="p-5">
                <CardTitle className="text-base leading-6">{period}</CardTitle>
                <CardDescription className="mt-1 text-base leading-6">
                    아직 올라오지 않았습니다.
                </CardDescription>
            </CardHeader>
        </Card>
    );
}
