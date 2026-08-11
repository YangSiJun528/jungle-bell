import {
    ArrowRight,
    RefreshCw,
    Smartphone,
    Utensils,
    WashingMachine,
    type LucideIcon,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from '@/components/ui/card';
import {Skeleton} from '@/components/ui/skeleton';
import {PageHeader} from '@/components/dashboard/page-header';
import {useCampusDataIssue, useDashboardEnvironment} from '@/app/dashboard-context';
import {
    useLaundryQuery,
    useMealsQuery,
    useRefreshHomeMutation,
} from '@/app/use-dashboard-queries';
import {readInitialPairingEntry} from '@/features/connections/pairing-bootstrap';
import {JungleCampusSummary} from './jungle-campus-summary';
import {
    homeLaundrySummary,
    homeTodayMeals,
    mealPeriodLabel,
    type HomeQueryState,
} from './home-view-model';

function queryState(query: {isPending: boolean; isError: boolean; data?: unknown}): HomeQueryState {
    if (query.data !== undefined) return 'ready';
    if (query.isError) return 'error';
    return query.isPending ? 'pending' : 'ready';
}

function SummaryCard({icon: Icon, title, children, footer, className}: {
    icon: LucideIcon;
    title: string;
    children: ReactNode;
    footer: ReactNode;
    className?: string;
}) {
    return (
        <Card className={className}>
            <CardHeader>
                <div className="flex items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Icon aria-hidden="true" className="size-5"/>
                    </span>
                    <h2 className="font-semibold leading-none">{title}</h2>
                </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">{children}</CardContent>
            <CardFooter className="gap-2 border-t">{footer}</CardFooter>
        </Card>
    );
}

function CardLoading({lines = 2}: {lines?: number}) {
    return (
        <div className="space-y-2" aria-label="정보를 불러오는 중">
            {Array.from({length: lines}, (_, index) => (
                <Skeleton key={index} className={index === lines - 1 ? 'h-4 w-2/3' : 'h-4 w-full'}/>
            ))}
        </div>
    );
}

function CompactError({retry}: {retry: () => void}) {
    return (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
            <p>정보를 불러오지 못했습니다.</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={retry}>다시 시도</Button>
        </div>
    );
}

export interface HomePageProps {
    onRequestInstall?: () => void;
}

export function HomePage({onRequestInstall}: HomePageProps = {}) {
    const {surface} = useDashboardEnvironment();
    const laundry = useLaundryQuery();
    const meals = useMealsQuery();
    const laundryIssue = useCampusDataIssue('laundry');
    const mealsIssue = useCampusDataIssue('meals');
    const refreshHome = useRefreshHomeMutation();
    const qrRequiresInstalledPwa = surface.kind === 'public'
        && readInitialPairingEntry()?.kind === 'public-install-required';

    const laundrySummary = homeLaundrySummary({
        queryState: queryState(laundry),
        snapshot: laundry.data,
    });
    const todayMeals = homeTodayMeals(meals.data);
    const laundryRefreshFailed = laundry.isError || laundryIssue !== null;
    const mealsRefreshFailed = meals.isError || mealsIssue !== null;
    return (
        <div className="space-y-6">
            <PageHeader
                title="오늘 필요한 정보"
                actions={surface.kind !== 'public' ? (
                    <Button variant="outline" disabled={refreshHome.isPending} onClick={() => refreshHome.mutate()}>
                        <RefreshCw aria-hidden="true" className={refreshHome.isPending ? 'animate-spin' : ''}/>
                        {refreshHome.isPending ? '갱신 중' : '전체 새로고침'}
                    </Button>
                ) : undefined}
            />

            <JungleCampusSummary onRequestInstall={onRequestInstall}/>

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
                            다시 시도
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}

            {qrRequiresInstalledPwa ? (
                <Alert className="border-primary/20 bg-primary/5">
                    <Smartphone aria-hidden="true"/>
                    <AlertTitle>이 QR은 설치한 모바일 PWA에서 열어야 합니다.</AlertTitle>
                    <AlertDescription>
                        <p>일반 브라우저에서는 일회용 연결 정보를 사용하지 않았습니다. Jungle Bell을 홈 화면에 추가한 뒤 PC 앱에서 새 QR을 만들어 다시 열어 주세요.</p>
                    </AlertDescription>
                </Alert>
            ) : null}

            <section className="grid gap-4 lg:grid-cols-2" aria-label="오늘의 생활 정보">
                <SummaryCard
                    icon={WashingMachine}
                    title="세탁실"
                    footer={<Button asChild variant="link" className="px-0"><a href="#laundry">기기별 현황 보기 <ArrowRight/></a></Button>}
                >
                    {laundry.isPending && !laundry.data ? (
                        <CardLoading/>
                    ) : laundryRefreshFailed && !laundry.data ? (
                        <CompactError retry={() => void laundry.refetch()}/>
                    ) : laundry.data ? (
                        <>
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
                                <>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded-lg bg-blue-500/10 p-3">
                                            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">남성</p>
                                            <p className="mt-1 text-2xl font-bold">{laundrySummary.men === null ? '—' : `${laundrySummary.men}회`}</p>
                                        </div>
                                        <div className="rounded-lg bg-rose-500/10 p-3">
                                            <p className="text-xs font-medium text-rose-700 dark:text-rose-300">여성</p>
                                            <p className="mt-1 text-2xl font-bold">{laundrySummary.women === null ? '—' : `${laundrySummary.women}회`}</p>
                                        </div>
                                    </div>
                                </>
                            )}
                        </>
                    ) : null}
                </SummaryCard>

                <SummaryCard
                    icon={Utensils}
                    title="오늘 급식"
                    footer={<Button asChild variant="link" className="px-0"><a href="#meals">전체 식단 보기 <ArrowRight/></a></Button>}
                >
                    {meals.isPending && !meals.data ? (
                        <CardLoading lines={3}/>
                    ) : mealsRefreshFailed && !meals.data ? (
                        <CompactError retry={() => void meals.refetch()}/>
                    ) : meals.data ? (
                        <>
                            {mealsRefreshFailed ? (
                                <p className="text-xs text-amber-700 dark:text-amber-300">최신 식단을 가져오지 못해 마지막 확인값을 표시합니다.</p>
                            ) : null}
                            {todayMeals.length === 0 ? (
                                <p className="text-sm leading-6 text-muted-foreground">
                                    {mealsRefreshFailed
                                        ? '마지막으로 확인한 데이터에는 오늘 식단이 없습니다.'
                                        : '오늘 식단이 아직 게시되지 않았습니다.'}
                                </p>
                            ) : (
                                <ul className="divide-y rounded-lg border">
                                    {todayMeals.slice(0, 2).map((meal) => (
                                        <li key={meal.id} className="grid grid-cols-[3rem_1fr] gap-3 p-3 text-sm">
                                            <strong className="text-primary">{mealPeriodLabel(meal)}</strong>
                                            <span className="line-clamp-2 whitespace-pre-line text-muted-foreground">{meal.text || meal.title || '메뉴 준비 중'}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    ) : null}
                </SummaryCard>

            </section>
        </div>
    );
}

export default HomePage;
