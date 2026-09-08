import {ExternalLink} from 'lucide-react';
import {useState} from 'react';

import type {DashboardMealPost} from '@/api/dashboard-api';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';

import {weekRangeLabel} from '../lib/meal-view';

export function WeeklyMealMenu({
    meal,
    weekKey,
    showSourceLink = true,
}: {
    meal: DashboardMealPost;
    weekKey: string;
    showSourceLink?: boolean;
}) {
    const images = meal.images ?? [];
    const title = meal.title ?? '이번 주 급식표';
    const range = weekRangeLabel(weekKey);
    const textAlternative = meal.text.trim();
    const [isImageExpanded, setIsImageExpanded] = useState(false);
    const imageSectionId = `${meal.id}-image-preview`;

    return (
        <Card className="overflow-hidden py-0 shadow-none">
            <CardHeader className="px-5 pt-5">
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{range}</CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5">
                <div className="grid gap-4">
                    {textAlternative ? (
                        <section aria-label="급식표 텍스트 내용" className="grid gap-2">
                            <h3 className="text-base leading-6 font-semibold">
                                급식표 텍스트 내용
                            </h3>
                            <p className="text-base leading-6 whitespace-pre-wrap">
                                {textAlternative}
                            </p>
                        </section>
                    ) : null}
                    {images.length > 0 ? (
                        <>
                            <div
                                aria-hidden={!isImageExpanded}
                                className={`grid gap-3 overflow-hidden rounded-lg border bg-muted/30 transition-[max-height] duration-200 ${
                                    isImageExpanded ? 'max-h-none' : 'max-h-44'
                                }`}
                                id={imageSectionId}
                            >
                                {images.map((image, index) => (
                                    <a
                                        aria-label={`${title} 급식표${images.length > 1 ? ` ${index + 1}` : ''} 새 탭에서 열기`}
                                        className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                        href={image.url}
                                        key={image.sha}
                                        rel="noopener noreferrer"
                                        tabIndex={isImageExpanded ? undefined : -1}
                                        target="_blank"
                                    >
                                        <img
                                            alt={`${title}, ${range} 급식표${images.length > 1 ? ` ${index + 1}` : ''}`}
                                            className="w-full rounded-lg border bg-muted object-contain"
                                            decoding="async"
                                            height={image.height ?? undefined}
                                            loading="lazy"
                                            src={image.url}
                                            width={image.width ?? undefined}
                                        />
                                    </a>
                                ))}
                            </div>
                            <div className="min-h-11 w-full">
                                <Button
                                    aria-controls={imageSectionId}
                                    aria-expanded={isImageExpanded}
                                    className="min-h-11 w-full"
                                    variant="outline"
                                    onClick={() => setIsImageExpanded((current) => !current)}
                                >
                                    {isImageExpanded ? '이미지 접기' : '이미지 펼치기'}
                                </Button>
                            </div>
                        </>
                    ) : textAlternative ? null : (
                        <p className="text-base leading-6 text-muted-foreground" role="status">
                            급식표 이미지와 텍스트 내용이 아직 등록되지 않았습니다.
                        </p>
                    )}
                    {showSourceLink && meal.permalink ? (
                        <Button asChild className="justify-self-start" variant="outline">
                            <a href={meal.permalink} rel="noreferrer" target="_blank">
                                <ExternalLink />
                                급식표 보러가기
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}
