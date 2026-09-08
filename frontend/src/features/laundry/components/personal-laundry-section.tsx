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
    canCreateWatch?: boolean;
    machines: DashboardLaundrySnapshot['machines'];
}

interface LaundryWatchCardProps {
    activeWatches: readonly LaundryWatch[];
    adding: boolean;
    busy: boolean;
    canCreateWatch: boolean;
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

function isLaundryApplianceKind(value: string): value is LaundryApplianceKind {
    return value === 'washer' || value === 'dryer';
}

function isLaundryNotificationMode(value: string): value is LaundryNotificationMode {
    return (
        value === 'before-completion' ||
        value === 'estimated-completion' ||
        value === 'confirmed-completion'
    );
}

interface LaundryWatchCardModel {
    addDisabled: boolean;
    applianceTargets: LaundryTarget[];
    machineIds: string[];
    sessionUnavailable: boolean;
}

function laundryWatchCardModel(props: LaundryWatchCardProps): LaundryWatchCardModel {
    const {activeWatches, busy, canCreateWatch, notificationMode, notifyBeforeMinutes} = props;
    const {selectedTarget, targets} = props;
    const sessionUnavailable = selectedTarget?.sessionId === null;
    const invalidMinutes =
        notificationMode === 'before-completion' &&
        (notifyBeforeMinutes < 1 || notifyBeforeMinutes > 180);

    return {
        addDisabled:
            !canCreateWatch ||
            !selectedTarget ||
            sessionUnavailable ||
            invalidMinutes ||
            busy ||
            hasDuplicateActiveWatch(activeWatches, selectedTarget),
        applianceTargets: targets.filter(
            (target) => target.machineId === selectedTarget?.machineId,
        ),
        machineIds: [...new Set(targets.map((target) => target.machineId))],
        sessionUnavailable,
    };
}

function LaundryWatchSelectors({
    applianceTargets,
    machineIds,
    notificationMode,
    selectedTarget,
    onApplianceChange,
    onMachineChange,
    onModeChange,
}: Pick<
    LaundryWatchCardProps,
    'notificationMode' | 'selectedTarget' | 'onApplianceChange' | 'onMachineChange' | 'onModeChange'
> &
    Pick<LaundryWatchCardModel, 'applianceTargets' | 'machineIds'>) {
    return (
        <div
            className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-laundry-watch-controls="true"
        >
            <div className="min-w-0 space-y-2">
                <Label className="text-base leading-6">워시타워 번호</Label>
                <Select value={selectedTarget?.machineId ?? ''} onValueChange={onMachineChange}>
                    <SelectTrigger
                        aria-label="워시타워 번호"
                        className="w-full min-w-0"
                        data-laundry-watch-machine="true"
                    >
                        <SelectValue placeholder="워시타워 선택" />
                    </SelectTrigger>
                    <SelectContent>
                        {machineIds.map((machineId) => (
                            <SelectItem
                                className="text-base leading-6"
                                key={machineId}
                                value={machineId}
                            >
                                {machineLabel(machineId)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="min-w-0 space-y-2">
                <Label className="text-base leading-6">세탁기 또는 건조기</Label>
                <Select
                    value={selectedTarget?.appliance ?? ''}
                    onValueChange={(value) => {
                        if (isLaundryApplianceKind(value)) onApplianceChange(value);
                    }}
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
                                className="text-base leading-6"
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
                <Label className="text-base leading-6">알림 시점</Label>
                <Select
                    value={notificationMode}
                    onValueChange={(value) => {
                        if (isLaundryNotificationMode(value)) onModeChange(value);
                    }}
                >
                    <SelectTrigger
                        aria-label="알림 시점"
                        className="w-full min-w-0"
                        data-laundry-watch-mode="true"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem className="text-base leading-6" value="before-completion">
                            N분 남았을 때
                        </SelectItem>
                        <SelectItem className="text-base leading-6" value="estimated-completion">
                            완료 예상
                        </SelectItem>
                        <SelectItem className="text-base leading-6" value="confirmed-completion">
                            완료 확정
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}

function LaundryWatchCondition({
    addDisabled,
    adding,
    notificationMode,
    notifyBeforeMinutes,
    onAdd,
    onNotifyBeforeMinutesChange,
}: Pick<
    LaundryWatchCardProps,
    'adding' | 'notificationMode' | 'notifyBeforeMinutes' | 'onAdd' | 'onNotifyBeforeMinutesChange'
> &
    Pick<LaundryWatchCardModel, 'addDisabled'>) {
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end">
            {notificationMode === 'before-completion' ? (
                <div className="min-w-0 flex-1 space-y-2">
                    <Label className="text-base leading-6" htmlFor="laundry-notify-before-minutes">
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
                            if (Number.isInteger(value)) onNotifyBeforeMinutesChange(value);
                        }}
                    />
                </div>
            ) : (
                <p className="min-w-0 flex-1 text-base leading-6 text-muted-foreground">
                    {notificationMode === 'estimated-completion'
                        ? '예상 종료 시각에 알립니다.'
                        : '기기에서 완료가 확인되면 알립니다.'}
                </p>
            )}
            <Button
                className="w-full shrink-0 sm:w-auto"
                data-laundry-watch-add="true"
                disabled={addDisabled}
                onClick={onAdd}
            >
                {adding ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                    <BellPlus />
                )}
                알림 확정
            </Button>
        </div>
    );
}

function ActiveLaundryWatches({
    activeWatches,
    busy,
    onRemove,
}: Pick<LaundryWatchCardProps, 'activeWatches' | 'busy' | 'onRemove'>) {
    if (activeWatches.length === 0) {
        return (
            <p className="text-base leading-6 text-muted-foreground">
                설정된 세탁 알림이 없습니다.
            </p>
        );
    }

    return (
        <ul className="min-w-0 divide-y rounded-lg border">
            {activeWatches.map((watch) => (
                <li
                    className="flex min-w-0 items-center gap-3 p-3"
                    data-laundry-watch-item="true"
                    key={watch.id}
                >
                    <Bell aria-hidden="true" className="size-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                        <p
                            className="text-base leading-6 font-medium break-words"
                            data-laundry-watch-target="true"
                        >
                            {machineLabel(watch.machineId)} · {applianceLabel(watch.appliance)}
                        </p>
                        <p
                            className="text-base leading-6 break-words text-muted-foreground"
                            data-laundry-watch-condition="true"
                        >
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
    );
}

function LaundryWatchLoadedContent(props: LaundryWatchCardProps) {
    const model = laundryWatchCardModel(props);

    return (
        <>
            {props.targets.length > 0 ? (
                <>
                    <LaundryWatchSelectors
                        applianceTargets={model.applianceTargets}
                        machineIds={model.machineIds}
                        notificationMode={props.notificationMode}
                        selectedTarget={props.selectedTarget}
                        onApplianceChange={props.onApplianceChange}
                        onMachineChange={props.onMachineChange}
                        onModeChange={props.onModeChange}
                    />
                    <LaundryWatchCondition
                        addDisabled={model.addDisabled}
                        adding={props.adding}
                        notificationMode={props.notificationMode}
                        notifyBeforeMinutes={props.notifyBeforeMinutes}
                        onAdd={props.onAdd}
                        onNotifyBeforeMinutesChange={props.onNotifyBeforeMinutesChange}
                    />
                </>
            ) : (
                <p className="rounded-lg bg-muted/50 p-4 text-base leading-6 text-muted-foreground">
                    기기 상태가 확인되면 알림 대상을 선택할 수 있습니다.
                </p>
            )}
            {!props.canCreateWatch ? (
                <p className="text-base leading-6 text-amber-700 dark:text-amber-300">
                    실시간 정보가 아닐 때는 새 세탁 알림을 설정할 수 없습니다.
                </p>
            ) : null}
            {model.sessionUnavailable ? (
                <p className="text-base leading-6 text-muted-foreground">
                    현재 동작 중인 기기만 알림을 설정할 수 있습니다.
                </p>
            ) : null}
            <p
                className="text-base leading-6 text-muted-foreground"
                data-laundry-watch-guide="true"
            >
                알림 시점: N분 남음, 완료 예상, 완료 확정
            </p>
            <ActiveLaundryWatches
                activeWatches={props.activeWatches}
                busy={props.busy}
                onRemove={props.onRemove}
            />
        </>
    );
}

function LaundryWatchCard(props: LaundryWatchCardProps) {
    return (
        <Card className="min-w-0 gap-4 overflow-hidden">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bell aria-hidden="true" className="size-4 text-primary" />
                    내 세탁 알림
                </CardTitle>
                <CardDescription className="text-base leading-6">
                    워시타워와 기기, 알림 시점을 선택해 한 가지 조건만 설정합니다.
                </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
                {props.loading ? (
                    <LoadingState label="세탁 알림을 불러오고 있습니다." />
                ) : (
                    <LaundryWatchLoadedContent {...props} />
                )}
            </CardContent>
        </Card>
    );
}

function personalLaundrySelection(
    machines: DashboardLaundrySnapshot['machines'],
    selectedMachineId: string,
    selectedAppliance: LaundryApplianceKind,
) {
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

    return {
        selectedTarget:
            targetsForMachine.find((target) => target.appliance === effectiveAppliance) ?? null,
        targets,
    };
}

function usePersonalLaundryController({
    canCreateWatch = true,
    machines,
}: PersonalLaundrySectionProps) {
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

    const {selectedTarget, targets} = personalLaundrySelection(
        machines,
        selectedMachineId,
        selectedAppliance,
    );
    const activeWatches = (watches.data ?? []).filter((watch) => watch.status === 'active');
    const personalBusy = addWatch.isPending || removeWatch.isPending;
    const personalError = watches.error ?? addWatch.error ?? removeWatch.error;
    const authRequired =
        attendance.data?.state === 'auth-required' || accountAuthenticationRequired(personalError);

    const addSelectedWatch = () => {
        if (!selectedTarget) return;
        addWatch.mutate(
            buildLaundryWatchInput(selectedTarget, notificationMode, notifyBeforeMinutes),
        );
    };

    return {
        activeWatches,
        addSelectedWatch,
        addWatch,
        attendance,
        attendanceReady,
        authRequired,
        canCreateWatch,
        notificationMode,
        notifyBeforeMinutes,
        personalBusy,
        personalError,
        refreshAttendance,
        removeWatch,
        selectedTarget,
        targets,
        watches,
        setNotificationMode,
        setNotifyBeforeMinutes,
        setSelectedAppliance,
        setSelectedMachineId,
    };
}

type PersonalLaundryController = ReturnType<typeof usePersonalLaundryController>;

function PersonalLaundryAuthRequired() {
    return (
        <Alert>
            <Smartphone aria-hidden="true" />
            <AlertTitle className="text-base leading-6">PC 연결이 필요합니다.</AlertTitle>
            <AlertDescription className="text-base leading-6">
                PC 앱 연결 후 개인 세탁 기능 사용 가능
            </AlertDescription>
        </Alert>
    );
}

function PersonalLaundryAttendanceError({controller}: {controller: PersonalLaundryController}) {
    return (
        <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="text-base leading-6">계정 상태 확인 실패</AlertTitle>
            <AlertDescription className="text-base leading-6">
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void controller.attendance.refetch()}
                >
                    새로고침
                </Button>
            </AlertDescription>
        </Alert>
    );
}

function PersonalLaundrySyncRequired({controller}: {controller: PersonalLaundryController}) {
    return (
        <Alert>
            <RefreshCw aria-hidden="true" />
            <AlertTitle className="text-base leading-6">출석 동기화가 필요합니다.</AlertTitle>
            <AlertDescription className="text-base leading-6">
                <Button
                    className="mt-2"
                    disabled={controller.refreshAttendance.isPending}
                    size="sm"
                    variant="outline"
                    onClick={() => controller.refreshAttendance.mutate()}
                >
                    {controller.refreshAttendance.isPending ? '새로고침 중' : '새로고침'}
                </Button>
            </AlertDescription>
        </Alert>
    );
}

function PersonalLaundryReady({controller}: {controller: PersonalLaundryController}) {
    return (
        <section className="min-w-0 space-y-4" aria-label="개인 세탁 기능">
            <LaundryWatchCard
                activeWatches={controller.activeWatches}
                adding={controller.addWatch.isPending}
                busy={controller.personalBusy}
                canCreateWatch={controller.canCreateWatch}
                loading={controller.watches.isPending}
                notificationMode={controller.notificationMode}
                notifyBeforeMinutes={controller.notifyBeforeMinutes}
                selectedTarget={controller.selectedTarget}
                targets={controller.targets}
                onAdd={controller.addSelectedWatch}
                onApplianceChange={controller.setSelectedAppliance}
                onMachineChange={controller.setSelectedMachineId}
                onModeChange={controller.setNotificationMode}
                onNotifyBeforeMinutesChange={controller.setNotifyBeforeMinutes}
                onRemove={(id) => controller.removeWatch.mutate(id)}
            />

            {controller.personalError ? (
                <Alert variant="destructive">
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle className="text-base leading-6">세탁 알림 처리 실패</AlertTitle>
                    <AlertDescription className="gap-3 text-base leading-6">
                        <p>잠시 후 새로고침하세요.</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void controller.watches.refetch()}
                        >
                            새로고침
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
        </section>
    );
}

function PersonalLaundryContent({controller}: {controller: PersonalLaundryController}) {
    if (controller.authRequired) return <PersonalLaundryAuthRequired />;
    if (controller.attendance.isPending) {
        return <LoadingState label="개인 세탁 기능 준비 중" />;
    }
    if (controller.attendance.isError) {
        return <PersonalLaundryAttendanceError controller={controller} />;
    }
    if (!controller.attendanceReady) {
        return <PersonalLaundrySyncRequired controller={controller} />;
    }
    return <PersonalLaundryReady controller={controller} />;
}

function AuthenticatedPersonalLaundrySection(props: PersonalLaundrySectionProps) {
    const controller = usePersonalLaundryController(props);
    return <PersonalLaundryContent controller={controller} />;
}

export function PersonalLaundrySection(props: PersonalLaundrySectionProps) {
    return (
        <PersonalFeatureSlot>
            <AuthenticatedPersonalLaundrySection {...props} />
        </PersonalFeatureSlot>
    );
}
