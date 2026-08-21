import {useMutation} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {ArrowRight, CalendarCheck, Check, ExternalLink, RefreshCw, X} from 'lucide-react';

import type {AttendanceSnapshot} from '@/api/dashboard-api';
import {useDashboardAccount} from '@/app/dashboard-account';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {useAttendanceQuery, useRefreshAttendanceMutation} from '@/app/use-dashboard-queries';
import {DdayCard} from '@/components/dashboard/dday-card';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardFooter, CardHeader} from '@/components/ui/card';
import {Skeleton} from '@/components/ui/skeleton';
import {selectDdayView} from '@/domain/attendance/dday-view';
import {dateTimeLabel} from '@/lib/format';

import {homeAttendanceState} from './home-view-model';

const CAMPUS_URL = 'https://jungle-lms.krafton.com/check-in';

function AttendanceCheck({label, checked}: {label: string; checked: boolean}) {
    return (
        <div
            className={
                checked
                    ? 'flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300'
                    : 'flex items-center gap-2 rounded-lg bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300'
            }
        >
            {checked ? (
                <Check aria-hidden="true" className="size-4" />
            ) : (
                <X aria-hidden="true" className="size-4" />
            )}
            <span className="text-sm">
                <strong>{label}</strong> {checked ? '완료' : '미완료'}
            </span>
        </div>
    );
}

function AttendanceChecks({snapshot}: {snapshot: AttendanceSnapshot}) {
    return (
        <div className="grid grid-cols-2 gap-2" aria-label="오늘 출석 상태">
            <AttendanceCheck label="학습 시작" checked={snapshot.morningChecked} />
            <AttendanceCheck label="학습 종료" checked={snapshot.eveningChecked} />
        </div>
    );
}

function CampusCardFrame({children, footer}: {children: React.ReactNode; footer: React.ReactNode}) {
    return (
        <Card
            className="h-[20rem] gap-0 overflow-hidden border-primary/20 py-0"
            data-home-campus-card="true"
        >
            <CardHeader className="min-h-20 shrink-0 px-5 py-4 sm:px-6">
                <div className="flex items-center gap-3">
                    <span
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
                        data-home-campus-status-icon="true"
                    >
                        <CalendarCheck aria-hidden="true" className="size-5" />
                    </span>
                    <div className="min-w-0">
                        <h2 className="leading-none font-semibold">정글캠퍼스</h2>
                    </div>
                </div>
            </CardHeader>
            <CardContent
                aria-label="정글캠퍼스 출석 요약"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 sm:px-6"
                tabIndex={0}
            >
                <div className="flex min-h-full flex-col justify-center gap-3">{children}</div>
            </CardContent>
            <CardFooter className="min-h-14 shrink-0 flex-wrap gap-2 border-t px-5 py-3 sm:px-6">
                {footer}
            </CardFooter>
        </Card>
    );
}

export function JungleCampusSummary() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    const openCampus = useMutation({mutationFn: () => api.openLmsLogin()});

    const desktopLocalAttendanceAvailable =
        platform.capabilities.desktopAccount &&
        attendance.data?.state === 'loaded' &&
        attendance.data.attendance.status === 'available' &&
        attendance.data.attendance.source === 'desktop';
    const personalReady =
        account.personalAccess.status === 'connected' || desktopLocalAttendanceAvailable;
    const dday = personalReady
        ? selectDdayView({
              platform: platform.kind,
              attendance: attendance.data,
          })
        : null;
    const attendanceState = personalReady
        ? homeAttendanceState(attendance.data)
        : ({kind: 'unavailable'} as const);
    const availableAttendance =
        attendanceState.kind === 'current' ? attendanceState.attendance : null;

    let content: React.ReactNode;
    if (platform.kind === 'browser' && account.personalAccess.status === 'not-applicable') {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium">
                    출석과 D-Day는 PC 앱 또는 연결된 PWA에서 확인할 수 있습니다.
                </p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">앱 연결 안내</Link>
                </Button>
            </div>
        );
    } else if (platform.kind === 'browser' && account.personalAccess.status === 'checking') {
        content = (
            <div className="space-y-2" aria-label="PC 연결 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">PC 연결 상태를 확인하고 있습니다.</p>
            </div>
        );
    } else if (platform.kind === 'browser' && account.personalAccess.status === 'unconnected') {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium">출석과 D-Day 확인을 위해 PC 연결이 필요합니다.</p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">기기 연결 열기</Link>
                </Button>
            </div>
        );
    } else if (platform.kind === 'browser' && account.personalAccess.status === 'error') {
        content = (
            <div className="text-sm leading-6">
                <p className="text-destructive">PC 연결 상태를 확인하지 못했습니다.</p>
                <Button
                    className="mt-2"
                    disabled={account.browserSessionQuery.isFetching}
                    size="sm"
                    variant="outline"
                    onClick={() => void account.browserSessionQuery.refetch()}
                >
                    {account.browserSessionQuery.isFetching ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        account.status.lmsAuthentication === 'checking'
    ) {
        content = (
            <div className="space-y-2" aria-label="LMS 로그인 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">
                    LMS 로그인 상태를 확인하고 있습니다.
                </p>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        account.status.lmsAuthentication === 'required'
    ) {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium">LMS 로그인이 필요합니다.</p>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        account.status.lmsAuthentication === 'unavailable'
    ) {
        content = (
            <div className="text-sm leading-6">
                <p className="text-destructive">LMS 로그인 상태를 확인하지 못했습니다.</p>
                <Button
                    className="mt-2"
                    disabled={account.connectionQuery.isFetching}
                    size="sm"
                    variant="outline"
                    onClick={() => void account.connectionQuery.refetch()}
                >
                    {account.connectionQuery.isFetching ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'checking'
    ) {
        content = (
            <div className="space-y-2" aria-label="계정 연결 상태 확인 중">
                <Skeleton className="h-10 w-full" />
                <p className="text-sm text-muted-foreground">계정 연결 상태를 확인하고 있습니다.</p>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'recovery-required'
    ) {
        content = (
            <div className="text-sm leading-6">
                <p className="text-destructive">계정 복구가 필요합니다.</p>
                <Button asChild className="mt-2" size="sm" variant="outline">
                    <Link to="/connections">연결 설정</Link>
                </Button>
            </div>
        );
    } else if (
        platform.capabilities.desktopAccount &&
        !desktopLocalAttendanceAvailable &&
        account.status.serverSession === 'missing'
    ) {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium">계정 연결이 필요합니다.</p>
                <Button
                    className="mt-2"
                    disabled={refreshAttendance.isPending}
                    size="sm"
                    onClick={() => refreshAttendance.mutate()}
                >
                    {refreshAttendance.isPending ? '연결 중' : '계정 연결'}
                </Button>
            </div>
        );
    } else if (attendance.isPending && !attendance.data) {
        content = (
            <div className="space-y-2" aria-label="출석 정보를 불러오는 중">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
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
                    {refreshAttendance.isPending ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    } else if (attendance.data?.state === 'auth-required') {
        content = (
            <p className="text-sm leading-6 text-muted-foreground">
                PC 앱과 다시 연결하면 오늘 출석 상태가 표시됩니다.
            </p>
        );
    } else if (attendance.data?.attendance.status === 'unavailable') {
        content = (
            <p className="text-sm leading-6 text-muted-foreground">
                PC에서 처음 출석 정보를 동기화하기를 기다리고 있습니다.
            </p>
        );
    } else if (attendanceState.kind === 'stale') {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                    마지막 출석 확인 이후 시간이 지났습니다.
                </p>
                <p className="mt-1 text-muted-foreground">
                    마지막 확인 · {dateTimeLabel(attendanceState.attendance.lastSyncedAt)}
                </p>
                <Button
                    className="mt-2"
                    disabled={refreshAttendance.isPending}
                    size="sm"
                    variant="outline"
                    onClick={() => refreshAttendance.mutate()}
                >
                    {refreshAttendance.isPending ? '새로고침 중' : '새로고침'}
                </Button>
            </div>
        );
    } else if (attendanceState.kind === 'different-attendance-day') {
        content = (
            <div className="text-sm leading-6">
                <p className="font-medium">새 출석일 상태를 확인하고 있습니다.</p>
                <p className="mt-1 text-muted-foreground">
                    마지막 확인 · {dateTimeLabel(attendanceState.attendance.lastSyncedAt)}
                </p>
                <Button
                    className="mt-2"
                    disabled={refreshAttendance.isPending}
                    size="sm"
                    variant="outline"
                    onClick={() => refreshAttendance.mutate()}
                >
                    {refreshAttendance.isPending ? '확인 중' : '지금 확인'}
                </Button>
            </div>
        );
    } else {
        content = (
            <>
                {availableAttendance ? (
                    <AttendanceChecks snapshot={availableAttendance.snapshot} />
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                        {availableAttendance
                            ? `${availableAttendance.source === 'desktop' ? '마지막 확인' : '마지막 동기화'} · ${dateTimeLabel(availableAttendance.lastSyncedAt)}`
                            : '동기화 기록 없음'}
                    </span>
                    {availableAttendance?.syncState === 'pending' ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                            <RefreshCw aria-hidden="true" className="size-3" /> 다른 기기 동기화
                            대기 중
                        </span>
                    ) : attendance.isError && attendance.data ? (
                        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                            <RefreshCw aria-hidden="true" className="size-3" /> 마지막 확인값 표시
                            중
                        </span>
                    ) : null}
                </div>
            </>
        );
    }

    return (
        <div className="space-y-4" data-home-campus-section="true">
            <CampusCardFrame
                footer={
                    <>
                        {platform.capabilities.lmsWindow ? (
                            <Button
                                size="sm"
                                disabled={openCampus.isPending}
                                onClick={() => openCampus.mutate()}
                            >
                                {openCampus.isPending
                                    ? '여는 중'
                                    : account.status.lmsAuthentication === 'required'
                                      ? 'LMS 로그인'
                                      : '정글캠퍼스 열기'}{' '}
                                <ExternalLink />
                            </Button>
                        ) : (
                            <Button asChild size="sm">
                                <a href={CAMPUS_URL} target="_blank" rel="noopener noreferrer">
                                    정글캠퍼스 열기 <ExternalLink />
                                </a>
                            </Button>
                        )}
                        <Button asChild size="sm" variant="link" className="px-1">
                            <Link to="/attendance">
                                출석 상세 보기 <ArrowRight />
                            </Link>
                        </Button>
                        {openCampus.isError ? (
                            <span className="text-xs text-destructive">
                                정글캠퍼스를 열지 못했습니다.
                            </span>
                        ) : null}
                    </>
                }
            >
                {content}
            </CampusCardFrame>
            {dday ? <DdayCard view={dday} /> : null}
        </div>
    );
}
