import {ExternalLink} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import type {DashboardMealPost} from '@/dashboard-api';
import {dateTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';

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
    return (
        <Card className={cn('overflow-hidden py-0 shadow-none', compact && 'gap-4')}>
            {images.length > 0 ? (
                <div className={cn('grid gap-px bg-border', images.length > 1 && 'grid-cols-2')}>
                    {images.map((image, index) => (
                        <img
                            alt={`${title} \uC0AC\uC9C4${images.length > 1 ? ` ${index + 1}` : ''}`}
                            className={cn(
                                'aspect-[4/3] size-full bg-muted object-cover',
                                compact && 'max-h-64',
                            )}
                            decoding="async"
                            height={image.height ?? undefined}
                            key={image.sha}
                            loading={eagerImage && index === 0 ? 'eager' : 'lazy'}
                            src={image.url}
                            width={image.width ?? undefined}
                        />
                    ))}
                </div>
            ) : null}
            <CardHeader className="px-5 pt-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle className="line-clamp-2 text-base leading-6">{title}</CardTitle>
                        <CardDescription className="mt-1">{dateTimeLabel(meal.publishedAt)}</CardDescription>
                    </div>
                    {meal.permalink ? (
                        <Button asChild size="icon-sm" variant="ghost">
                            <a
                                aria-label="식단 원문 열기"
                                href={meal.permalink}
                                rel="noreferrer"
                                target="_blank"
                            >
                                <ExternalLink/>
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className={cn(
                'whitespace-pre-wrap px-5 pb-5 text-sm leading-6 text-foreground/85',
                compact && 'line-clamp-5',
            )}>
                {meal.text || '\uBA54\uB274 \uB0B4\uC6A9\uC774 \uB4F1\uB85D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.'}
            </CardContent>
        </Card>
    );
}
