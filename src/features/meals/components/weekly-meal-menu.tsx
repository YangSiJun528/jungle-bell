import {ExternalLink} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import type {DashboardMealPost} from '@/api/dashboard-api';
import {weekRangeLabel} from '../lib/meal-view';

export function WeeklyMealMenu({meal, weekKey, showSourceLink = true}: {
    meal: DashboardMealPost;
    weekKey: string;
    showSourceLink?: boolean;
}) {
    const images = meal.images ?? [];
    const title = meal.title ?? '이번 주 급식표';
    const range = weekRangeLabel(weekKey);
    const textAlternative = meal.text.trim();
    return (
        <Card className="overflow-hidden py-0 shadow-none">
            <CardHeader className="px-5 pt-5">
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{range}</CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5">
                <div className="grid gap-4">
                    {images.length > 0 ? (
                        <div className="grid gap-3">
                            {images.map((image, index) => (
                                <a
                                    aria-label={`${title} 급식표${images.length > 1 ? ` ${index + 1}` : ''} 새 탭에서 열기`}
                                    className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    href={image.url}
                                    key={image.sha}
                                    rel="noopener noreferrer"
                                    target="_blank"
                                >
                                    <img
                                        alt={`${title}, ${range} 급식표${images.length > 1 ? ` ${index + 1}` : ''}`}
                                        className="max-h-[72vh] w-full rounded-lg border bg-muted object-contain"
                                        decoding="async"
                                        height={image.height ?? undefined}
                                        loading="lazy"
                                        src={image.url}
                                        width={image.width ?? undefined}
                                    />
                                </a>
                            ))}
                        </div>
                    ) : null}
                    {textAlternative ? (
                        <section aria-label="급식표 텍스트 내용" className="grid gap-2">
                            <h3 className="text-sm font-semibold">급식표 텍스트 내용</h3>
                            <p className="whitespace-pre-wrap text-sm leading-6">{textAlternative}</p>
                        </section>
                    ) : images.length === 0 ? (
                        <p className="text-sm text-muted-foreground" role="status">
                            급식표 이미지와 텍스트 내용이 아직 등록되지 않았습니다.
                        </p>
                    ) : null}
                    {showSourceLink && meal.permalink ? (
                        <Button asChild className="justify-self-start" variant="outline">
                            <a href={meal.permalink} rel="noreferrer" target="_blank">
                                <ExternalLink/>
                                급식표 보러가기
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}
