import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CircleAlert, FolderOpen, Laptop, RefreshCw} from 'lucide-react';
import type {DesktopSettings} from '@/api/desktop-settings';
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
    const settings = useQuery({
        queryKey: queryKeys.desktopSettings,
        queryFn: () => api.getDesktopSettings(),
    });
    const save = useMutation({
        mutationFn: (input: DesktopSettings) => api.updateDesktopSettings(input),
        onSuccess: async (value) => {
            client.setQueryData(queryKeys.desktopSettings, value);
            await client.invalidateQueries({queryKey: queryKeys.desktopSettings});
        },
    });
    const openLogs = useMutation({mutationFn: () => api.openLogFolder()});
    const value = settings.data;
    const update = (key: keyof DesktopSettings, checked: boolean) => {
        if (!value) return;
        save.mutate({...value, [key]: checked});
    };

    if (settings.isPending && !value) {
        return <LoadingState label="서비스 설정을 불러오고 있습니다."/>;
    }
    if (settings.isError && !value) {
        return <ErrorState title="서비스 설정을 불러오지 못했습니다." retry={() => void settings.refetch()}/>;
    }
    if (!value) return null;

    return (
        <div className="space-y-4">
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
                        onCheckedChange={(checked) => update('debugMode', checked)}
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
        </div>
    );
}

export function ServiceSettings() {
    const {surface} = useDashboardEnvironment();
    if (surface.kind === 'desktop') return <DesktopServiceSettings/>;
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
