import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
    Bell,
    BellPlus,
    CircleAlert,
    Clock3,
    LoaderCircle,
    Smartphone,
    X,
} from 'lucide-react';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
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
    LaundryQueueEntry,
    LaundryWatch,
} from '@/dashboard-api';
import {companionAuthenticationRequired} from '@/dashboard-model';
import type {PersonalSurface} from '@/dashboard-personal-api';
import {
    applianceLabel,
    hasDuplicateActiveWatch,
    hasWaitingQueue,
    laundryTargets,
    machineLabel,
    queueStatusLabel,
    watchConditionLabel,
    type LaundryTarget,
} from '@/dashboard-personal-state';

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
        <Card className="gap-4">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bell className="size-4 text-primary"/>
                    내 세탁 알림
                </CardTitle>
                <CardDescription>동작 종료 10분 전, 완료 또는 다음 사용 가능 시 알려드려요.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {loading ? (
                    <LoadingState label="세탁 알림을 불러오고 있습니다."/>
                ) : (
                    <>
                        {targets.length > 0 ? (
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <Select
                                    value={selectedTarget?.key ?? ''}
                                    onValueChange={onTargetChange}
                                >
                                    <SelectTrigger className="w-full sm:flex-1">
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

interface LaundryQueueCardProps {
    busy: boolean;
    entries: readonly LaundryQueueEntry[];
    loading: boolean;
    onJoin: (appliance: 'washer' | 'dryer') => void;
    onLeave: (id: string) => void;
}

function LaundryQueueCard({
    busy,
    entries,
    loading,
    onJoin,
    onLeave,
}: LaundryQueueCardProps) {
    const visibleEntries = entries.filter((entry) => entry.status !== 'cancelled');

    return (
        <Card className="gap-4">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Clock3 className="size-4 text-primary"/>
                    자율 대기열
                </CardTitle>
                <CardDescription>기기 예약이 아닌 사용자 간 순서 안내 기능입니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {loading ? (
                    <LoadingState label="대기열을 불러오고 있습니다."/>
                ) : (
                    <>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {(['washer', 'dryer'] as const).map((appliance) => {
                                const waiting = entries.find((entry) =>
                                    entry.status === 'waiting' && entry.appliance === appliance);
                                return waiting ? (
                                    <Button
                                        disabled={busy}
                                        key={appliance}
                                        variant="outline"
                                        onClick={() => onLeave(waiting.id)}
                                    >
                                        <X/>
                                        {applianceLabel(appliance)} 대기 취소
                                    </Button>
                                ) : (
                                    <Button
                                        disabled={busy || hasWaitingQueue(entries, appliance)}
                                        key={appliance}
                                        variant="outline"
                                        onClick={() => onJoin(appliance)}
                                    >
                                        <Clock3/>
                                        {applianceLabel(appliance)} 대기 참여
                                    </Button>
                                );
                            })}
                        </div>
                        {visibleEntries.length > 0 ? (
                            <ul className="divide-y rounded-lg border">
                                {visibleEntries.map((entry) => (
                                    <li className="flex items-center justify-between gap-3 p-3" key={entry.id}>
                                        <span className="text-sm font-medium">{applianceLabel(entry.appliance)}</span>
                                        <span className="text-xs text-muted-foreground">{queueStatusLabel(entry)}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">참여 중인 자율 대기열이 없습니다.</p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

export function PersonalLaundrySection({
    surface,
    machines,
}: PersonalLaundrySectionProps) {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const [selectedTargetKey, setSelectedTargetKey] = useState('');

    const watches = useQuery({
        queryKey: queryKeys.laundryWatches,
        queryFn: () => api.listLaundryWatches(surface),
    });
    const queue = useQuery({
        queryKey: queryKeys.laundryQueue,
        queryFn: () => api.listLaundryQueue(surface),
    });

    const invalidateWatches = () => client.invalidateQueries({queryKey: queryKeys.laundryWatches});
    const invalidateQueue = () => client.invalidateQueries({queryKey: queryKeys.laundryQueue});
    const addWatch = useMutation({
        mutationFn: (target: LaundryTarget) => api.createLaundryWatch(surface, {
            machineId: target.machineId,
            appliance: target.appliance,
            sessionId: target.sessionId,
            notifyBeforeMinutes: target.sessionId === null ? 0 : 10,
            notifyWhenAvailable: true,
        }),
        onSuccess: invalidateWatches,
    });
    const removeWatch = useMutation({
        mutationFn: (id: string) => api.deleteLaundryWatch(surface, id),
        onSuccess: invalidateWatches,
    });
    const joinQueue = useMutation({
        mutationFn: (appliance: 'washer' | 'dryer') => api.joinLaundryQueue(
            surface,
            {machineId: null, appliance},
        ),
        onSuccess: invalidateQueue,
    });
    const leaveQueue = useMutation({
        mutationFn: (id: string) => api.leaveLaundryQueue(surface, id),
        onSuccess: invalidateQueue,
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
    const personalBusy = addWatch.isPending
        || removeWatch.isPending
        || joinQueue.isPending
        || leaveQueue.isPending;
    const personalError = watches.error
        ?? queue.error
        ?? addWatch.error
        ?? removeWatch.error
        ?? joinQueue.error
        ?? leaveQueue.error;
    const authRequired = surface === 'companion' && companionAuthenticationRequired(personalError);

    if (authRequired) {
        return (
            <Alert>
                <Smartphone/>
                <AlertTitle>PC 연결이 필요합니다.</AlertTitle>
                <AlertDescription>
                    연결 메뉴에서 이 PWA를 PC 앱과 연결한 뒤 개인 세탁 기능을 사용할 수 있어요.
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <section className="grid gap-4 xl:grid-cols-2" aria-label="개인 세탁 기능">
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

            <LaundryQueueCard
                busy={personalBusy}
                entries={queue.data ?? []}
                loading={queue.isPending}
                onJoin={(appliance) => joinQueue.mutate(appliance)}
                onLeave={(id) => leaveQueue.mutate(id)}
            />

            {personalError ? (
                <Alert className="xl:col-span-2" variant="destructive">
                    <CircleAlert/>
                    <AlertTitle>개인 세탁 기능을 처리하지 못했습니다.</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>연결 상태를 확인한 뒤 다시 시도해 주세요.</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void Promise.all([watches.refetch(), queue.refetch()])}
                        >
                            다시 시도
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
        </section>
    );
}
