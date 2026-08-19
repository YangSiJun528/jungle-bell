import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CircleAlert, FolderOpen, Laptop, RefreshCw} from 'lucide-react';
import type {DesktopSettingsUpdate} from '@/platform/contracts';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Separator} from '@/components/ui/separator';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Switch} from '@/components/ui/switch';

function ServiceSettingRow({title, description, checked, disabled, onCheckedChange}: {
    title: string;
    description: string;
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            </div>
            <Switch
                aria-label={title}
                checked={checked}
                disabled={disabled}
                onCheckedChange={onCheckedChange}
            />
        </div>
    );
}

function DesktopServiceSettings() {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const [confirmAutoUpdateOff, setConfirmAutoUpdateOff] = useState(false);
    const [confirmDebugOn, setConfirmDebugOn] = useState(false);
    const [cohortDraft, setCohortDraft] = useState<string | null | undefined>(undefined);
    const settings = useQuery({
        queryKey: queryKeys.desktopSettings,
        queryFn: () => api.getDesktopSettings(),
        refetchInterval: 30_000,
    });
    const save = useMutation({
        mutationFn: (input: DesktopSettingsUpdate) => api.updateDesktopSettings(input),
        onSuccess: async (value) => {
            client.setQueryData(queryKeys.desktopSettings, value);
            await client.invalidateQueries({queryKey: queryKeys.desktopSettings});
        },
    });
    const openLogs = useMutation({mutationFn: () => api.openLogFolder()});
    const value = settings.data;
    const update = (key: 'autoStart' | 'autoUpdate' | 'usageAnalytics' | 'debugMode', checked: boolean) => {
        if (!value) return;
        save.mutate({...value, [key]: checked});
    };
    const updateSelectedCohort = (selectedCohortId: string | null) => {
        if (!value) return;
        save.mutate({...value, selectedCohortId}, {
            onSuccess: () => setCohortDraft(undefined),
        });
    };

    if (settings.isPending && !value) {
        return <LoadingState label="서비스 설정을 불러오고 있습니다."/>;
    }
    if (settings.isError && !value) {
        return <ErrorState title="서비스 설정을 불러오지 못했습니다." retry={() => void settings.refetch()}/>;
    }
    if (!value) return null;

    const savedCohortId = value.selectedCohortId
        && value.cohortOptions.some(({id}) => id === value.selectedCohortId)
        ? value.selectedCohortId
        : null;
    const displayedCohortId = cohortDraft === undefined ? savedCohortId : cohortDraft;
    const cohortDirty = cohortDraft !== undefined && cohortDraft !== savedCohortId;
    const effectiveCohortLabel = value.cohortOptions
        .find(({id}) => id === value.effectiveCohortId)?.label ?? null;

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>정글 LMS</CardTitle>
                    <CardDescription>출석과 D-Day를 확인할 기수를 선택합니다.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                        <div>
                            <p className="text-sm font-medium">출석 확인 기수</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                자동 선택은 현재 날짜에 맞는 활성 기수를 사용합니다.
                            </p>
                        </div>
                        <Select
                            disabled={save.isPending || value.cohortOptions.length === 0}
                            value={displayedCohortId ?? 'automatic'}
                            onValueChange={(value) => setCohortDraft(value === 'automatic' ? null : value)}
                        >
                            <SelectTrigger aria-label="출석 확인 기수" className="w-full sm:w-64">
                                <SelectValue placeholder="기수를 선택하세요"/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="automatic">자동 선택</SelectItem>
                                {value.cohortOptions.map((cohort) => (
                                    <SelectItem key={cohort.id} value={cohort.id}>{cohort.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {value.cohortOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">LMS 로그인 후 기수 목록이 표시됩니다.</p>
                    ) : (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                                현재 적용 · {effectiveCohortLabel ?? '자동 선택 대기 중'}
                            </p>
                            <Button
                                disabled={save.isPending || !cohortDirty}
                                onClick={() => {
                                    if (cohortDraft !== undefined) updateSelectedCohort(cohortDraft);
                                }}
                            >
                                {save.isPending ? '적용 중' : '변경사항 적용'}
                            </Button>
                        </div>
                    )}
                    {cohortDirty ? (
                        <p className="text-xs text-amber-700 dark:text-amber-300">적용하지 않은 기수 변경이 있습니다.</p>
                    ) : null}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>앱 실행</CardTitle>
                    <CardDescription>이 PC에서 Jungle Bell을 실행하고 업데이트하는 방식을 정합니다.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ServiceSettingRow
                        title="자동 시작"
                        description="운영체제에 로그인하면 백그라운드에서 Jungle Bell을 시작합니다."
                        checked={value.autoStart}
                        disabled={save.isPending}
                        onCheckedChange={(checked) => update('autoStart', checked)}
                    />
                    <Separator/>
                    <ServiceSettingRow
                        title="자동 업데이트"
                        description="서명된 최신 버전을 확인하고 자동으로 설치합니다."
                        checked={value.autoUpdate}
                        disabled={save.isPending}
                        onCheckedChange={(checked) => {
                            if (checked) update('autoUpdate', true);
                            else setConfirmAutoUpdateOff(true);
                        }}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>개인정보</CardTitle>
                    <CardDescription>서비스 개선을 위해 보내는 최소 사용 기록을 제어합니다.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ServiceSettingRow
                        title="사용 통계"
                        description="설치 식별자의 일방향 해시, 앱 버전, 운영체제와 기능 사용 이벤트만 전송합니다. 출석·식단 내용과 LMS 계정 정보는 전송하지 않습니다."
                        checked={value.usageAnalytics}
                        disabled={save.isPending}
                        onCheckedChange={(checked) => update('usageAnalytics', checked)}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>진단</CardTitle>
                    <CardDescription>문제를 확인할 때만 상세 로그를 켜고 앱 로그를 확인합니다.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ServiceSettingRow
                        title="디버그 모드"
                        description="상세 진단 로그를 기록합니다. 개발자 도구나 외부 명령 실행 권한은 열지 않습니다."
                        checked={value.debugMode}
                        disabled={save.isPending}
                        onCheckedChange={(checked) => {
                            if (checked) setConfirmDebugOn(true);
                            else update('debugMode', false);
                        }}
                    />
                    <Separator/>
                    <div className="flex items-center justify-between gap-4 py-4">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">로그 폴더</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">Jungle Bell 전용 로그 디렉터리를 파일 탐색기에서 엽니다.</p>
                        </div>
                        <Button variant="outline" disabled={openLogs.isPending} onClick={() => openLogs.mutate()}>
                            <FolderOpen aria-hidden="true"/>
                            {openLogs.isPending ? '여는 중' : '열기'}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {(save.isError || openLogs.isError) ? (
                <Alert variant="destructive">
                    <CircleAlert/>
                    <AlertTitle>서비스 설정을 처리하지 못했습니다.</AlertTitle>
                    <AlertDescription>잠시 후 다시 시도하세요.</AlertDescription>
                </Alert>
            ) : null}

            <AlertDialog open={confirmAutoUpdateOff} onOpenChange={setConfirmAutoUpdateOff}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>자동 업데이트를 끌까요?</AlertDialogTitle>
                        <AlertDialogDescription>
                            외부 서비스가 변경되면 출석 확인과 알림이 정상적으로 작동하지 않을 수 있습니다.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>취소</AlertDialogCancel>
                        <AlertDialogAction onClick={() => update('autoUpdate', false)}>그래도 끄기</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={confirmDebugOn} onOpenChange={setConfirmDebugOn}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>디버그 모드를 켤까요?</AlertDialogTitle>
                        <AlertDialogDescription>
                            평소보다 많은 진단 로그가 저장됩니다. 문제 분석 같은 특별한 목적이 없다면 켜지 마세요.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>아니요</AlertDialogCancel>
                        <AlertDialogAction onClick={() => update('debugMode', true)}>
                            네, 디버그 모드 켜기
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

export function ServiceSettings() {
    const {platform} = useDashboardEnvironment();
    if (platform.capabilities.desktopSettings) return <DesktopServiceSettings/>;
    return (
        <Alert>
            <Laptop/>
            <AlertTitle>PC 앱에서 설정합니다.</AlertTitle>
            <AlertDescription>
                자동 시작, 업데이트, 사용 통계와 진단 로그는 각 PC에만 적용되므로 PC 앱에서 변경할 수 있습니다.
            </AlertDescription>
        </Alert>
    );
}
