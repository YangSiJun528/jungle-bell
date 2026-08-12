import {useMutation} from '@tanstack/react-query';
import {
    ArrowRight,
    CalendarCheck,
    Check,
    ExternalLink,
    RefreshCw,
    ShieldCheck,
    X,
} from 'lucide-react';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {
    useAttendanceQuery,
    useHomeOverviewQuery,
    useRefreshAttendanceMutation,
} from '@/app/use-dashboard-queries';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from '@/components/ui/card';
import {Skeleton} from '@/components/ui/skeleton';
import type {AttendanceSnapshot} from '@/api/dashboard-api';
import {dateTimeLabel} from '@/lib/format';
import {HomeDdayCard} from './components/home-dday-card';
import {selectHomeDday} from './lib/home-dday';
import {homeAttendanceForToday} from './home-view-model';

const CAMPUS_URL = 'https://jungle-lms.krafton.com/check-in';

function AttendanceCheck({label, checked}: {label: string; checked: boolean}) {
    return (
        <div className={checked
            ? 'flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300'
            : 'flex items-center gap-2 rounded-lg bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300'}>
            {checked
                ? <Check aria-hidden="true" className="size-4"/>
                : <X aria-hidden="true" className="size-4"/>}
            <span className="text-sm"><strong>{label}</strong> {checked ? '완료' : '미완료'}</span>
        </div>
    );
}

function AttendanceChecks({snapshot}: {snapshot: AttendanceSnapshot}) {
    return (
        <div className="grid grid-cols-2 gap-2" aria-label="오늘 출석 상태">
            <AttendanceCheck label="오전" checked={snapshot.morningChecked}/>
            <AttendanceCheck label="오후" checked={snapshot.eveningChecked}/>
        </div>
    );
}

function CampusCardFrame({children, footer}: {
    children: React.ReactNode;
    footer: React.ReactNode;
}) {
    return (
        <Card className="h-[20rem] gap-0 overflow-hidden border-primary/20 py-0" data-home-campus-card="true">
            <CardHeader className="min-h-20 shrink-0 px-5 py-4 sm:px-6">
                <div className="flex items-center gap-3">
                    <span
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
                        data-home-campus-status-icon="true"
                    >
                        <CalendarCheck aria-hidden="true" className="size-5"/>
                    </span>
                    <div className="min-w-0">
                        <h2 className="font-semibold leading-none">정글캠퍼스</h2>
                    </div>
                </div>
            </CardHeader>
            <CardContent
                aria-label="정글캠퍼스 출석 요약"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 sm:px-6"
                tabIndex={0}
            >
                <div className="flex min-h-full flex-col justify-center gap-3">
                    {children}
                </div>
            </CardContent>
            <CardFooter className="min-h-14 shrink-0 flex-wrap gap-2 border-t px-5 py-3 sm:px-6">
                {footer}
            </CardFooter>
        </Card>
    );
}

function PublicCampusContent({onRequestInstall}: {onRequestInstall?: () => void}) {
    return (
        <CampusCardFrame
            footer={(
                <>
                    {onRequestInstall ? (
                        <Button size="sm" onClick={onRequestInstall}>앱 설치 안내</Button>
                    ) : null}
                    <Button asChild size="sm" variant="outline">
                        <a href={CAMPUS_URL} target="_blank" rel="noopener noreferrer">
                            공식 페이지 <ExternalLink/>
                        </a>
                    </Button>
                </>
            )}
        >
            <div className="flex items-start gap-3">
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary"/>
                <div>
                    <p className="font-medium">앱을 설치하고 PC와 연결하면 오늘 출석 상태를 확인할 수 있습니다.</p>
                </div>
            </div>
        </CampusCardFrame>
    );
}

export interface JungleCampusSummaryProps {
    onRequestInstall?: () => void;
}

export function JungleCampusSummary({onRequestInstall}: JungleCampusSummaryProps) {
    const {api, surface} = useDashboardEnvironment();
    const attendance = useAttendanceQuery();
    const overview = useHomeOverviewQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    const openCampus = useMutation({mutationFn: () => api.openLmsLogin()});

    if (surface.kind === 'public') {
        return <PublicCampusContent onRequestInstall={onRequestInstall}/>;
    }

    const dday = selectHomeDday({
        surface: surface.kind,
        overview: overview.data,
        attendance: attendance.data,
    });
    const availableAttendance = homeAttendanceForToday(attendance.data);
    const attendanceNeedsRefresh = attendance.data?.state === 'loaded'
        && attendance.data.attendance.status === 'available'
        && availableAttendance === null;

    let content: React.ReactNode;
    if (attendance.isPending && !attendance.data) {
        content = (
            <div className="space-y-2" aria-label="출석 정보를 불러오는 중">
                <Skeleton className="h-10 w-full"/>
                <Skeleton className="h-10 w-full"/>
            </div>
        );
    } else if (attendance.isError && !attendance.data) {
        content = (
            <div className="text-sm">
                <p className="text-destructive">출석 정보를 불러오지 못했습니다.</p>
                <Button
                    className="mt-2"
                    disabled={refreshAttendance.isPending}
                    size="sm"
                    variant="outline"
                    onClick={() => refreshAttendance.mutate()}
                >
                    {refreshAttendance.isPending ? '확인 중' : '다시 시도'}
                </Button>
            </div>
        );
    } else if (attendance.data?.state === 'auth-required') {
        content = <p className="text-sm leading-6 text-muted-foreground">PC 앱과 다시 연결하면 오늘 출석 상태가 표시됩니다.</p>;
    } else if (attendance.data?.attendance.status === 'unavailable') {
        content = <p className="text-sm leading-6 text-muted-foreground">PC에서 처음 출석 정보를 동기화하기를 기다리고 있습니다.</p>;
    } else if (attendanceNeedsRefresh) {
        const lastSyncedAt = attendance.data?.state === 'loaded'
            && attendance.data.attendance.status === 'available'
            ? attendance.data.attendance.lastSyncedAt
            : null;
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium text-amber-800 dark:text-amber-300">오늘 출석 상태를 다시 확인해야 합니다.</p>
                <p className="mt-1 text-muted-foreground">
                    {lastSyncedAt ? `마지막 동기화 · ${dateTimeLabel(lastSyncedAt)}` : '오늘 기준의 동기화 기록이 없습니다.'}
                </p>
                <Button
                    className="mt-2"
                    disabled={refreshAttendance.isPending}
                    size="sm"
                    variant="outline"
                    onClick={() => refreshAttendance.mutate()}
                >
                    {refreshAttendance.isPending ? '확인 중' : '다시 확인'}
                </Button>
            </div>
        );
    } else {
        content = (
            <>
                {availableAttendance ? <AttendanceChecks snapshot={availableAttendance.snapshot}/> : null}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{availableAttendance ? `마지막 동기화 · ${dateTimeLabel(availableAttendance.lastSyncedAt)}` : '동기화 기록 없음'}</span>
                    {attendance.isError && attendance.data ? (
                        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                            <RefreshCw aria-hidden="true" className="size-3"/> 마지막 확인값 표시 중
                        </span>
                    ) : null}
                </div>
            </>
        );
    }

    return (
        <div className="space-y-4" data-home-campus-section="true">
            <CampusCardFrame
                footer={(
                    <>
                        {surface.kind === 'desktop' ? (
                            <Button size="sm" disabled={openCampus.isPending} onClick={() => openCampus.mutate()}>
                                {openCampus.isPending ? '여는 중' : '정글캠퍼스 열기'} <ExternalLink/>
                            </Button>
                        ) : (
                            <Button asChild size="sm">
                                <a href={CAMPUS_URL} target="_blank" rel="noopener noreferrer">정글캠퍼스 열기 <ExternalLink/></a>
                            </Button>
                        )}
                        <Button asChild size="sm" variant="link" className="px-1">
                            <a href="#attendance">출석 상세 보기 <ArrowRight/></a>
                        </Button>
                        {openCampus.isError ? <span className="text-xs text-destructive">정글캠퍼스를 열지 못했습니다.</span> : null}
                    </>
                )}
            >
                {content}
            </CampusCardFrame>
            {dday ? <HomeDdayCard view={dday}/> : null}
        </div>
    );
}
