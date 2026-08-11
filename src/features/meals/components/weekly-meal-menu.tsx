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
import {weekRangeLabel} from '../lib/meal-view';

export function WeeklyMealMenu({meal, weekKey}: {meal: DashboardMealPost; weekKey: string}) {
    const images = meal.images ?? [];
    const title = meal.title ?? '이번 주 급식표';
    const range = weekRangeLabel(weekKey);
    const textAlternative = meal.text.trim();
    return (
        <Card
            className="overflow-hidden py-0 shadow-none"
            data-text-alternative={textAlternative ? 'available' : 'unavailable'}
        >
            <CardHeader className="px-5 pt-5">
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{range}</CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5">
                <div className="grid gap-4">
                    {images.length > 0 ? (
                        <div className="grid gap-3">
                            {images.map((image, index) => (
                                <figure className="grid gap-2" key={image.sha}>
                                    <img
                                        alt={`${title}, ${range}, 요일별 급식 메뉴가 표로 정리된 상세 이미지${images.length > 1 ? ` ${index + 1}` : ''}`}
                                        className="max-h-[72vh] w-full rounded-lg border bg-muted object-contain"
                                        decoding="async"
                                        height={image.height ?? undefined}
                                        loading="lazy"
                                        src={image.url}
                                        width={image.width ?? undefined}
                                    />
                                    <figcaption className="text-xs leading-5 text-muted-foreground">
                                        {range}의 요일별 메뉴를 표 형태로 제공하는 급식표 상세 이미지입니다.
                                    </figcaption>
                                </figure>
                            ))}
                        </div>
                    ) : null}
                    {textAlternative ? (
                        <section aria-label="급식표 텍스트 내용" className="grid gap-2">
                            <h3 className="text-sm font-semibold">급식표 텍스트 내용</h3>
                            <p className="whitespace-pre-wrap text-sm leading-6">{textAlternative}</p>
                        </section>
                    ) : images.length > 0 ? (
                        <p className="text-xs leading-5 text-muted-foreground" role="status">
                            텍스트 형식의 상세 메뉴는 제공되지 않았습니다. 급식표 이미지 또는 원문에서 전체 내용을 확인해 주세요.
                        </p>
                    ) : (
                        <p className="text-sm text-muted-foreground" role="status">
                            급식표 이미지와 텍스트 내용이 아직 등록되지 않았습니다.
                        </p>
                    )}
                    {meal.permalink ? (
                        <Button asChild className="justify-self-start" variant="outline">
                            <a href={meal.permalink} rel="noreferrer" target="_blank">
                                <ExternalLink/>
                                급식표 원문에서 전체 내용 확인
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}
