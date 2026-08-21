import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Bell, BellPlus, CircleAlert, LoaderCircle, RefreshCw, Smartphone, X} from 'lucide-react';
import {useState} from 'react';

import {accountAuthenticationRequired} from '@/api/account-authentication';
import type {
    DashboardLaundrySnapshot,
    LaundryApplianceKind,
    LaundryNotificationMode,
    LaundryWatch,
} from '@/api/dashboard-api';
import {useDashboardAccount} from '@/app/dashboard-account';
import {assertLmsAuthenticated, assertServerSessionReady} from '@/app/dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {PersonalFeatureSlot} from '@/app/personal-feature-slot';
import {useAttendanceQuery, useRefreshAttendanceMutation} from '@/app/use-dashboard-queries';
import {LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    applianceLabel,
    buildLaundryWatchInput,
    hasDuplicateActiveWatch,
    laundryTargets,
    machineLabel,
    watchConditionLabel,
    type LaundryTarget,
} from '@/features/laundry/lib/personal-laundry';

interface PersonalLaundrySectionProps {
    machines: DashboardLaundrySnapshot['machines'];
}

interface LaundryWatchCardProps {
    activeWatches: readonly LaundryWatch[];
    adding: boolean;
    busy: boolean;
    loading: boolean;
    notificationMode: LaundryNotificationMode;
    notifyBeforeMinutes: number;
    selectedTarget: LaundryTarget | null;
    targets: readonly LaundryTarget[];
    onAdd: () => void;
    onApplianceChange: (appliance: LaundryApplianceKind) => void;
    onMachineChange: (machineId: string) => void;
    onModeChange: (mode: LaundryNotificationMode) => void;
    onNotifyBeforeMinutesChange: (value: number) => void;
    onRemove: (id: string) => void;
}

function LaundryWatchCard({
    activeWatches,
    adding,
    busy,
    loading,
    notificationMode,
    notifyBeforeMinutes,
    selectedTarget,
    targets,
    onAdd,
    onApplianceChange,
    onMachineChange,
    onModeChange,
    onNotifyBeforeMinutesChange,
    onRemove,
}: LaundryWatchCardProps) {
    const machineIds = [...new Set(targets.map((target) => target.machineId))];
    const applianceTargets = targets.filter(
        (target) => target.machineId === selectedTarget?.machineId,
    );
    const sessionUnavailable = selectedTarget?.sessionId === null;
    return (
        <Card className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bell className="size-4 text-primary" />
                    내 세탁 알림
                </CardTitle>
                <CardDescription>
                    워시타워와 기기, 알림 시점을 선택해 한 가지 조건만 설정합니다.
                </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
                {loading ? (
                    <LoadingState label="세탁 알림을 불러오고 있습니다." />
                ) : (
                    <>
                        {targets.length > 0 ? (
                            <div
                                data-laundry-watch-controls="true"
                                className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                            >
                                <div className="min-w-0 space-y-2">
                                    <Label>워시타워 번호</Label>
                                    <Select
                                        value={selectedTarget?.machineId ?? ''}
                                        onValueChange={onMachineChange}
                                    >
                                        <SelectTrigger
                                            aria-label="워시타워 번호"
                                            className="w-full min-w-0"
                                            data-laundry-watch-machine="true"
                                        >
                                            <SelectValue placeholder="워시타워 선택" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {machineIds.map((machineId) => (
                                                <SelectItem key={machineId} value={machineId}>
                                                    {machineLabel(machineId)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="min-w-0 space-y-2">
                                    <Label>세탁기 또는 건조기</Label>
                                    <Select
                                        value={selectedTarget?.appliance ?? ''}
                                        onValueChange={(value) =>
                                            onApplianceChange(value as LaundryApplianceKind)
                                        }
                                    >
                                        <SelectTrigger
                                            aria-label="세탁기 또는 건조기"
                                            className="w-full min-w-0"
                                            data-laundry-watch-appliance="true"
                                        >
                                            <SelectValue placeholder="기기 선택" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {applianceTargets.map((target) => (
                                                <SelectItem
                                                    key={target.appliance}
                                                    value={target.appliance}
                                                >
                                                    {applianceLabel(target.appliance)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="min-w-0 space-y-2">
                                    <Label>알림 시점</Label>
                                    <Select
                                        value={notificationMode}
                                        onValueChange={(value) =>
                                            onModeChange(value as LaundryNotificationMode)
                                        }
                                    >
                                        <SelectTrigger
                                            aria-label="알림 시점"
                                            className="w-full min-w-0"
                                            data-laundry-watch-mode="true"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="before-completion">
                                                N분 남았을 때
                                            </SelectItem>
                                            <SelectItem value="estimated-completion">
                                                완료 예상
                                            </SelectItem>
                                            <SelectItem value="confirmed-completion">
                                                완료 확정
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        ) : (
                            <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
                                기기 상태가 확인되면 알림 대상을 선택할 수 있습니다.
                            </p>
                        )}

                        {targets.length > 0 ? (
                            <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end">
                                {notificationMode === 'before-completion' ? (
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <Label htmlFor="laundry-notify-before-minutes">
                                            남은 시간(분)
                                        </Label>
                                        <Input
                                            id="laundry-notify-before-minutes"
                                            inputMode="numeric"
                                            max={180}
                                            min={1}
                                            type="number"
                                            value={notifyBeforeMinutes}
                                            onChange={(event) => {
                                                const value = Number(event.target.value);
                                                if (Number.isInteger(value))
                                                    onNotifyBeforeMinutesChange(value);
                                            }}
                                        />
                                    </div>
                                ) : (
                                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                                        {notificationMode === 'estimated-completion'
                                            ? '예상 종료 시각에 알립니다.'
                                            : '기기에서 완료가 확인되면 알립니다.'}
                                    </p>
                                )}
                                <Button
                                    data-laundry-watch-add="true"
                                    className="w-full shrink-0 sm:w-auto"
                                    disabled={
                                        !selectedTarget ||
                                        sessionUnavailable ||
                                        (notificationMode === 'before-completion' &&
                                            (notifyBeforeMinutes < 1 ||
                                                notifyBeforeMinutes > 180)) ||
                                        busy ||
                                        hasDuplicateActiveWatch(activeWatches, selectedTarget)
                                    }
                                    onClick={onAdd}
                                >
                                    {adding ? (
                                        <LoaderCircle className="animate-spin" />
                                    ) : (
                                        <BellPlus />
                                    )}
                                    알림 확정
                                </Button>
                            </div>
                        ) : null}

                        {sessionUnavailable ? (
                            <p className="text-sm text-muted-foreground">
                                현재 동작 중인 기기만 알림을 설정할 수 있습니다.
                            </p>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                            알림 시점: N분 남음, 완료 예상, 완료 확정
                        </p>

                        {activeWatches.length > 0 ? (
                            <ul className="divide-y rounded-lg border">
                                {activeWatches.map((watch) => (
                                    <li className="flex items-center gap-3 p-3" key={watch.id}>
                                        <Bell className="size-4 shrink-0 text-primary" />
                                        <div className="min-w-0 flex-1 text-sm">
                                            <p className="font-medium">
                                                {machineLabel(watch.machineId)} ·{' '}
                                                {applianceLabel(watch.appliance)}
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
                                            <X />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                설정된 세탁 알림이 없습니다.
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function AuthenticatedPersonalLaundrySection({machines}: PersonalLaundrySectionProps) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const attendance = useAttendanceQuery();
    const refreshAttendance = useRefreshAttendanceMutation();
    const client = useQueryClient();
    const [selectedMachineId, setSelectedMachineId] = useState('');
    const [selectedAppliance, setSelectedAppliance] = useState<LaundryApplianceKind>('washer');
    const [notificationMode, setNotificationMode] =
        useState<LaundryNotificationMode>('before-completion');
    const [notifyBeforeMinutes, setNotifyBeforeMinutes] = useState(10);
    const attendanceReady =
        attendance.data?.state === 'loaded' && attendance.data.attendance.status === 'available';

    const watches = useQuery({
        queryKey: queryKeys.laundryWatches,
        queryFn: () => api.listLaundryWatches(),
        enabled: attendanceReady,
    });

    const invalidateWatches = () => client.invalidateQueries({queryKey: queryKeys.laundryWatches});
    const assertPersonalAccess = () => {
        if (platform.capabilities.desktopAccount) {
            assertLmsAuthenticated(account.status);
            assertServerSessionReady(account.status);
        }
        if (!attendanceReady) throw new Error('PERSONAL_ACCOUNT_REQUIRED');
    };
    const addWatch = useMutation({
        mutationFn: (input: ReturnType<typeof buildLaundryWatchInput>) => {
            assertPersonalAccess();
            return api.createLaundryWatch(input);
        },
        onSuccess: invalidateWatches,
    });
    const removeWatch = useMutation({
        mutationFn: (id: string) => {
            assertPersonalAccess();
            return api.deleteLaundryWatch(id);
        },
        onSuccess: invalidateWatches,
    });

    const targets = laundryTargets(
        machines.map((machine) => ({
            ...machine,
            washer: machine.washer ? {...machine.washer, appliance: 'washer' as const} : null,
            dryer: machine.dryer ? {...machine.dryer, appliance: 'dryer' as const} : null,
        })),
    );
    const effectiveMachineId = targets.some((target) => target.machineId === selectedMachineId)
        ? selectedMachineId
        : (targets[0]?.machineId ?? '');
    const targetsForMachine = targets.filter((target) => target.machineId === effectiveMachineId);
    const effectiveAppliance = targetsForMachine.some(
        (target) => target.appliance === selectedAppliance,
    )
        ? selectedAppliance
        : (targetsForMachine[0]?.appliance ?? 'washer');
    const selectedTarget =
        targetsForMachine.find((target) => target.appliance === effectiveAppliance) ?? null;
    const activeWatches = (watches.data ?? []).filter((watch) => watch.status === 'active');
    const personalBusy = addWatch.isPending || removeWatch.isPending;
    const personalError = watches.error ?? addWatch.error ?? removeWatch.error;
    const authRequired =
        attendance.data?.state === 'auth-required' || accountAuthenticationRequired(personalError);

    if (authRequired) {
        return (
            <Alert>
                <Smartphone />
                <AlertTitle>PC 연결이 필요합니다.</AlertTitle>
                <AlertDescription>PC 앱 연결 후 개인 세탁 기능 사용 가능</AlertDescription>
            </Alert>
        );
    }

    if (attendance.isPending) {
        return <LoadingState label="개인 세탁 기능 준비 중" />;
    }

    if (attendance.isError) {
        return (
            <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
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
                <RefreshCw aria-hidden="true" />
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
                notificationMode={notificationMode}
                notifyBeforeMinutes={notifyBeforeMinutes}
                selectedTarget={selectedTarget}
                targets={targets}
                onAdd={() =>
                    selectedTarget &&
                    addWatch.mutate(
                        buildLaundryWatchInput(
                            selectedTarget,
                            notificationMode,
                            notifyBeforeMinutes,
                        ),
                    )
                }
                onApplianceChange={setSelectedAppliance}
                onMachineChange={setSelectedMachineId}
                onModeChange={setNotificationMode}
                onNotifyBeforeMinutesChange={setNotifyBeforeMinutes}
                onRemove={(id) => removeWatch.mutate(id)}
            />

            {personalError ? (
                <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>세탁 알림 처리 실패</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>잠시 후 새로고침하세요.</p>
                        <Button size="sm" variant="outline" onClick={() => void watches.refetch()}>
                            새로고침
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
        </section>
    );
}

export function PersonalLaundrySection(props: PersonalLaundrySectionProps) {
    return (
        <PersonalFeatureSlot>
            <AuthenticatedPersonalLaundrySection {...props} />
        </PersonalFeatureSlot>
    );
}
