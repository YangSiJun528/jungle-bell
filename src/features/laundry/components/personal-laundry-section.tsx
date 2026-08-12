import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
    Bell,
    BellPlus,
    CircleAlert,
    LoaderCircle,
    RefreshCw,
    Smartphone,
    X,
} from 'lucide-react';
import {
    assertLmsAuthenticated,
    assertServerSessionReady,
    useDashboardAccount,
} from '@/app/dashboard-account';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {PersonalAccountGate} from '@/app/personal-account-gate';
import {useAttendanceQuery, useRefreshAttendanceMutation} from '@/app/use-dashboard-queries';
import {LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type {
    DashboardLaundrySnapshot,
    LaundryWatch,
} from '@/api/dashboard-api';
import {companionAuthenticationRequired} from '@/app/surface';
import type {PersonalSurface} from '@/api/personal-api';
import {
    applianceLabel,
    hasDuplicateActiveWatch,
    laundryTargets,
    machineLabel,
    watchConditionLabel,
    type LaundryTarget,
} from '@/features/laundry/lib/personal-laundry';

interface PersonalLaundrySectionProps {
    surface: PersonalSurface;
    machines: DashboardLaundrySnapshot['machines'];
}

interface LaundryWatchCardProps {
    activeWatches: readonly LaundryWatch[];
    adding: boolean;
    busy: boolean;
    loading: boolean;
    selectedTarget: LaundryTarget | null;
    targets: readonly LaundryTarget[];
    onAdd: () => void;
    onRemove: (id: string) => void;
    onTargetChange: (key: string) => void;
}

function LaundryWatchCard({
    activeWatches,
    adding,
    busy,
    loading,
    selectedTarget,
    targets,
    onAdd,
    onRemove,
    onTargetChange,
}: LaundryWatchCardProps) {
    return (
        <Card className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bell className="size-4 text-primary"/>
                    내 세탁 알림
                </CardTitle>
                <CardDescription>동작 종료 10분 전, 완료 또는 다음 사용 가능 시 알려드려요.</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
                {loading ? (
                    <LoadingState label="세탁 알림을 불러오고 있습니다."/>
                ) : (
                    <>
                        {targets.length > 0 ? (
                            <div
                                data-laundry-watch-controls="true"
                                className="flex min-w-0 flex-col gap-2 sm:flex-row"
                            >
                                <Select
                                    value={selectedTarget?.key ?? ''}
                                    onValueChange={onTargetChange}
                                >
                                    <SelectTrigger className="min-w-0 w-full sm:flex-1">
                                        <SelectValue placeholder="알림 대상을 선택하세요"/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {targets.map((target) => (
                                            <SelectItem key={target.key} value={target.key}>
                                                {target.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button
                                    data-laundry-watch-add="true"
                                    className="shrink-0"
                                    disabled={!selectedTarget
                                        || busy
                                        || hasDuplicateActiveWatch(activeWatches, selectedTarget)}
                                    onClick={onAdd}
                                >
                                    {adding
                                        ? <LoaderCircle className="animate-spin"/>
                                        : <BellPlus/>}
                                    알림 추가
                                </Button>
                            </div>
                        ) : (
                            <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
                                기기 상태가 확인되면 알림 대상을 선택할 수 있습니다.
                            </p>
                        )}

                        {activeWatches.length > 0 ? (
                            <ul className="divide-y rounded-lg border">
                                {activeWatches.map((watch) => (
                                    <li className="flex items-center gap-3 p-3" key={watch.id}>
                                        <Bell className="size-4 shrink-0 text-primary"/>
                                        <div className="min-w-0 flex-1 text-sm">
                                            <p className="font-medium">
                                                {machineLabel(watch.machineId)} · {applianceLabel(watch.appliance)}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {watchConditionLabel(watch)}
                                            </p>
                                        </div>
                                        <Button
                                            aria-label={`${machineLabel(watch.machineId)} 알림 취소`}
                                            disabled={busy}
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => onRemove(watch.id)}
                                        >
                                            <X/>
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">설정된 세탁 알림이 없습니다.</p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function AuthenticatedPersonalLaundrySection({
    surface,
    machines,
}: PersonalLaundrySectionProps) {
    const {api} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    const client = useQueryClient();
    const [selectedTargetKey, setSelectedTargetKey] = useState('');
    const attendanceReady = attendance.data?.state === 'loaded'
        && attendance.data.attendance.status === 'available';

    const watches = useQuery({
        queryKey: queryKeys.laundryWatches,
        queryFn: () => api.listLaundryWatches(surface),
        enabled: attendanceReady,
    });

    const invalidateWatches = () => client.invalidateQueries({queryKey: queryKeys.laundryWatches});
    const assertPersonalAccess = () => {
        if (surface === 'desktop') {
            assertLmsAuthenticated(account.status);
            assertServerSessionReady(account.status);
        }
        if (!attendanceReady) throw new Error('PERSONAL_ACCOUNT_REQUIRED');
    };
    const addWatch = useMutation({
        mutationFn: (target: LaundryTarget) => {
            assertPersonalAccess();
            return api.createLaundryWatch(surface, {
                machineId: target.machineId,
                appliance: target.appliance,
                sessionId: target.sessionId,
                notifyBeforeMinutes: target.sessionId === null ? 0 : 10,
                notifyWhenAvailable: true,
            });
        },
        onSuccess: invalidateWatches,
    });
    const removeWatch = useMutation({
        mutationFn: (id: string) => {
            assertPersonalAccess();
            return api.deleteLaundryWatch(surface, id);
        },
        onSuccess: invalidateWatches,
    });

    const targets = laundryTargets(machines.map((machine) => ({
        ...machine,
        washer: machine.washer ? {...machine.washer, appliance: 'washer' as const} : null,
        dryer: machine.dryer ? {...machine.dryer, appliance: 'dryer' as const} : null,
    })));
    const selectedTarget = targets.find((target) => target.key === selectedTargetKey)
        ?? targets[0]
        ?? null;
    const activeWatches = (watches.data ?? []).filter((watch) => watch.status === 'active');
    const personalBusy = addWatch.isPending || removeWatch.isPending;
    const personalError = watches.error
        ?? addWatch.error
        ?? removeWatch.error;
    const authRequired = surface === 'companion'
        && (attendance.data?.state === 'auth-required' || companionAuthenticationRequired(personalError));

    if (authRequired) {
        return (
            <Alert>
                <Smartphone/>
                <AlertTitle>PC 연결이 필요합니다.</AlertTitle>
                <AlertDescription>
                    PC 앱 연결 후 개인 세탁 기능 사용 가능
                </AlertDescription>
            </Alert>
        );
    }

    if (attendance.isPending) {
        return <LoadingState label="개인 세탁 기능 준비 중"/>;
    }

    if (attendance.isError) {
        return (
            <Alert variant="destructive">
                <CircleAlert aria-hidden="true"/>
                <AlertTitle>계정 상태 확인 실패</AlertTitle>
                <AlertDescription>
                    <Button size="sm" variant="outline" onClick={() => void attendance.refetch()}>
                        새로고침
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    if (!attendanceReady) {
        return (
            <Alert>
                <RefreshCw aria-hidden="true"/>
                <AlertTitle>출석 동기화가 필요합니다.</AlertTitle>
                <AlertDescription>
                    <Button
                        className="mt-2"
                        disabled={refreshAttendance.isPending}
                        size="sm"
                        variant="outline"
                        onClick={() => refreshAttendance.mutate()}
                    >
                        {refreshAttendance.isPending ? '새로고침 중' : '새로고침'}
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <section className="min-w-0 space-y-4" aria-label="개인 세탁 기능">
            <LaundryWatchCard
                activeWatches={activeWatches}
                adding={addWatch.isPending}
                busy={personalBusy}
                loading={watches.isPending}
                selectedTarget={selectedTarget}
                targets={targets}
                onAdd={() => selectedTarget && addWatch.mutate(selectedTarget)}
                onRemove={(id) => removeWatch.mutate(id)}
                onTargetChange={setSelectedTargetKey}
            />

            {personalError ? (
                <Alert variant="destructive">
                    <CircleAlert/>
                    <AlertTitle>세탁 알림 처리 실패</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>잠시 후 새로고침하세요.</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void watches.refetch()}
                        >
                            새로고침
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
        </section>
    );
}

export function PersonalLaundrySection(props: PersonalLaundrySectionProps) {
    const account = useDashboardAccount();

    if (props.surface === 'desktop' && account.status.lmsAuthentication !== 'authenticated') {
        return null;
    }

    return (
        <PersonalAccountGate>
            <AuthenticatedPersonalLaundrySection {...props}/>
        </PersonalAccountGate>
    );
}
