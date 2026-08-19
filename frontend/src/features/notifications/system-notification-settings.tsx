import {useMutation} from '@tanstack/react-query';
import {ExternalLink} from 'lucide-react';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';

export function SystemNotificationSettingsButton() {
    const {api, platform} = useDashboardEnvironment();
    const openSettings = useMutation({mutationFn: () => api.openSystemNotificationSettings()});

    if (!platform.capabilities.localNotifications) return null;

    return (
        <div className="flex flex-col items-start gap-2">
            <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={openSettings.isPending}
                onClick={() => openSettings.mutate()}
            >
                <ExternalLink aria-hidden="true" className="size-4"/>
                {openSettings.isPending ? '여는 중' : '알림 설정 열기'}
            </Button>
            {openSettings.isError ? (
                <p role="alert" className="text-xs text-destructive">
                    운영체제 알림 설정을 열지 못했습니다.
                </p>
            ) : null}
        </div>
    );
}

export function SystemNotificationSettingsCard() {
    const {platform} = useDashboardEnvironment();

    if (!platform.capabilities.localNotifications) return null;

    return (
        <Card>
            <CardHeader>
                <CardTitle>운영체제 알림 설정</CardTitle>
                <CardDescription>
                    Jungle Bell 알림이 보이지 않으면 운영체제에서 앱 알림 권한과 표시 방식을 확인하세요.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <SystemNotificationSettingsButton/>
            </CardContent>
        </Card>
    );
}
