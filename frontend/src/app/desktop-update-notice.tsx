import {useMutation, useQueryClient} from '@tanstack/react-query';
import {Download} from 'lucide-react';

import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';

import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {useDesktopUpdateQuery} from './desktop-update-query';

export function DesktopUpdateNotice() {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const {desktop, update} = useDesktopUpdateQuery();
    const install = useMutation({
        mutationFn: () => api.installDesktopUpdate(),
        onSuccess: async () => {
            await client.invalidateQueries({queryKey: queryKeys.desktopUpdate});
        },
    });

    if (!desktop || !update.data?.availableVersion || update.data.mandatory) return null;

    return (
        <Alert className="mb-4 border-amber-500/50 bg-amber-500/10">
            <Download aria-hidden="true" />
            <AlertTitle>Jungle Bell 업데이트가 필요합니다.</AlertTitle>
            <AlertDescription className="mt-1 gap-3 sm:flex sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p>
                        현재 v{update.data.currentVersion} · 최신 v{update.data.availableVersion}
                    </p>
                    {install.isError ? (
                        <p className="mt-1 text-destructive">
                            업데이트를 설치하지 못했습니다. 잠시 후 다시 시도하세요.
                        </p>
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
