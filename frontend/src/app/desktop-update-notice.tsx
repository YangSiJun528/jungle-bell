import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Download} from 'lucide-react';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export function DesktopUpdateNotice() {
    const {api, platform} = useDashboardEnvironment();
    const client = useQueryClient();
    const desktop = platform.kind === 'desktop' && platform.capabilities.desktopSettings;
    const settings = useQuery({
        queryKey: queryKeys.desktopSettings,
        queryFn: () => api.getDesktopSettings(),
        enabled: desktop,
        staleTime: 30_000,
    });
    const manualUpdate = desktop && settings.data?.autoUpdate === false;
    const update = useQuery({
        queryKey: queryKeys.desktopUpdate,
        queryFn: () => api.checkDesktopUpdate(),
        enabled: manualUpdate,
        staleTime: UPDATE_CHECK_INTERVAL_MS,
        refetchInterval: UPDATE_CHECK_INTERVAL_MS,
    });
    const install = useMutation({
        mutationFn: () => api.installDesktopUpdate(),
        onSuccess: async () => {
            await client.invalidateQueries({queryKey: queryKeys.desktopUpdate});
        },
    });

    if (!manualUpdate || !update.data?.availableVersion) return null;

    return (
        <Alert className="mb-4 border-amber-500/50 bg-amber-500/10">
            <Download aria-hidden="true"/>
            <AlertTitle>Jungle Bell 업데이트가 필요합니다.</AlertTitle>
            <AlertDescription className="mt-1 gap-3 sm:flex sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p>
                        현재 v{update.data.currentVersion} · 최신 v{update.data.availableVersion}
                    </p>
                    {install.isError ? (
                        <p className="mt-1 text-destructive">업데이트를 설치하지 못했습니다. 잠시 후 다시 시도하세요.</p>
                    ) : null}
                </div>
                <Button
                    size="sm"
                    className="shrink-0"
                    disabled={install.isPending}
                    onClick={() => install.mutate()}
                >
                    {install.isPending ? '업데이트 중' : '지금 업데이트'}
                </Button>
            </AlertDescription>
        </Alert>
    );
}
