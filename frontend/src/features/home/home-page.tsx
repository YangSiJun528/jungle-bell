import {
    ArrowRight,
    RefreshCw,
    Utensils,
    WashingMachine,
    type LucideIcon,
} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import type {ReactNode} from 'react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from '@/components/ui/card';
import {PageHeader} from '@/components/dashboard/page-header';
import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {AppShowcaseCard} from '@/components/app-showcase/app-showcase-card';
import {laundryZonePresentation} from '@/components/dashboard/laundry-zone-presentation';
import {
    useRefreshHomeMutation,
    useSuspenseCampusQueries,
} from '@/app/use-dashboard-queries';
import {cn} from '@/lib/utils';
import {HomeMealSlotsList} from './home-meal-slots';
import {
    homeLaundrySummary,
    homeTodayMealSlots,
} from './home-view-model';

function SummaryCard({icon: Icon, title, children, footer, className}: {
    icon: LucideIcon;
    title: string;
    children: ReactNode;
    footer: ReactNode;
    className?: string;
}) {
    return (
        <Card className={cn('min-h-60 gap-0 overflow-hidden py-0', className)}>
            <CardHeader className="min-h-16 shrink-0 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Icon aria-hidden="true" className="size-5"/>
                    </span>
                    <h2 className="font-semibold leading-none">{title}</h2>
                </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col justify-center gap-3 px-5 py-3 sm:px-6">
                {children}
            </CardContent>
            <CardFooter className="min-h-11 shrink-0 gap-2 border-t px-5 py-1.5 [.border-t]:pt-1.5 sm:px-6">
                {footer}
            </CardFooter>
        </Card>
    );
}

function HomeLivingSummaries() {
    const {laundry, meals} = useSuspenseCampusQueries();
    const laundrySummary = homeLaundrySummary({
        snapshot: laundry.data,
    });
    const todayMealSlots = homeTodayMealSlots(meals.data);
    const laundryRefreshFailed = laundry.isError;
    const mealsRefreshFailed = meals.isError;

    return (
        <section className="grid gap-4 lg:grid-cols-2" aria-label="오늘의 생활 정보">
            <SummaryCard
                icon={WashingMachine}
                title="세탁실"
                footer={<Button asChild size="sm" variant="link" className="px-0"><Link to="/laundry">기기별 현황 보기 <ArrowRight/></Link></Button>}
            >
                {laundryRefreshFailed ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">최신 상태를 가져오지 못해 마지막 확인값을 표시합니다.</p>
                ) : null}
                {laundry.data.machines.length === 0 ? (
                    <p className="text-sm leading-6 text-muted-foreground">
                        {laundryRefreshFailed
                            ? '마지막으로 확인한 데이터에 표시할 워시타워가 없습니다.'
                            : '표시할 워시타워 정보가 아직 없습니다.'}
                    </p>
                ) : (
                    <div className="grid grid-cols-2 gap-2">
                        <div className={cn('rounded-lg border p-3', laundryZonePresentation('men').surfaceClassName)}>
                            <p className="text-xs font-medium">남성 가능</p>
                            <p className="mt-1 flex items-baseline gap-2">
                                <strong className="text-2xl text-foreground">{laundrySummary.men === null ? '—' : `${laundrySummary.men}회`}</strong>
                                {laundrySummary.men === null ? null : (
                                    <span className="text-xs text-muted-foreground">지금 시작 가능</span>
                                )}
                            </p>
                        </div>
                        <div className={cn('rounded-lg border p-3', laundryZonePresentation('women').surfaceClassName)}>
                            <p className="text-xs font-medium">여성 가능</p>
                            <p className="mt-1 flex items-baseline gap-2">
                                <strong className="text-2xl text-foreground">{laundrySummary.women === null ? '—' : `${laundrySummary.women}회`}</strong>
                                {laundrySummary.women === null ? null : (
                                    <span className="text-xs text-muted-foreground">지금 시작 가능</span>
                                )}
                            </p>
                        </div>
                    </div>
                )}
            </SummaryCard>

            <SummaryCard
                icon={Utensils}
                title="오늘 급식"
                footer={<Button asChild size="sm" variant="link" className="px-0"><Link to="/meals">전체 식단 보기 <ArrowRight/></Link></Button>}
            >
                {mealsRefreshFailed ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">최신 식단을 가져오지 못해 마지막 확인값을 표시합니다.</p>
                ) : null}
                {todayMealSlots === null ? (
                    <p className="text-sm leading-6 text-muted-foreground">
                        {mealsRefreshFailed
                            ? '마지막으로 확인한 데이터에는 오늘 식단이 없습니다.'
                            : '오늘 식단이 아직 게시되지 않았습니다.'}
                    </p>
                ) : (
                    <HomeMealSlotsList slots={todayMealSlots}/>
                )}
            </SummaryCard>
        </section>
    );
}

export function HomePage() {
    const refreshHome = useRefreshHomeMutation();

    return (
        <div className="space-y-6">
            <PageHeader
                title="오늘 필요한 정보"
                actions={(
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" disabled={refreshHome.isPending} onClick={() => refreshHome.mutate()}>
                            <RefreshCw aria-hidden="true" className={refreshHome.isPending ? 'animate-spin' : ''}/>
                            {refreshHome.isPending ? '새로고침 중' : '새로고침'}
                        </Button>
                    </div>
                )}
            />

            <AppShowcaseCard/>

            {refreshHome.isError ? (
                <Alert variant="destructive">
                    <RefreshCw aria-hidden="true"/>
                    <AlertTitle>전체 정보를 갱신하지 못했습니다.</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>갱신하지 못한 항목은 마지막으로 확인한 정보를 계속 표시합니다.</p>
                        <Button
                            disabled={refreshHome.isPending}
                            size="sm"
                            variant="outline"
                            onClick={() => refreshHome.mutate()}
                        >
                            새로고침
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}

            <AsyncBoundary
                errorTitle="오늘의 생활 정보를 불러오지 못했습니다."
                errorDescription="앱 안내는 계속 확인할 수 있습니다. 잠시 후 다시 시도해 주세요."
            >
                <HomeLivingSummaries/>
            </AsyncBoundary>
        </div>
    );
}

export default HomePage;
