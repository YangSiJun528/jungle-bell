import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Check, ExternalLink, Send, Smartphone} from 'lucide-react';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {useDashboardAccount} from '@/app/dashboard-account';
import {PersonalAccountGate} from '@/app/personal-account-gate';
import {useNotificationsQuery} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {Button} from '@/components/ui/button';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Card} from '@/components/ui/card';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs';
import type {DashboardNotification} from '@/api/dashboard-api';
import {accountAuthenticationRequired} from '@/api/account-authentication';
import {dateTimeLabel} from '@/lib/format';
import {
    markNotificationInboxItemRead,
    type NotificationInboxItem,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';
import {desktopTestNotificationMessage, mobilePushErrorMessage} from './notification-result';
import {notificationRowsForTab} from './notification-tabs';

export function NotificationRow({item, unread, onActivate, onDismiss, dismissing = false, href}: {
    item: DashboardNotification | NotificationInboxItem;
    unread: boolean;
    onActivate?: () => void;
    onDismiss?: () => void;
    dismissing?: boolean;
    href?: string;
}) {
    const createdAt = 'createdAtEpochMs' in item ? item.createdAtEpochMs : item.createdAt;
    const content = (
        <>
            <span className="min-w-0 flex-1">
                <span className="sr-only">{unread ? '읽지 않은 알림. ' : '읽은 알림. '}</span>
                <span className="flex items-start justify-between gap-3">
                    <strong className="text-sm leading-5">{item.title}</strong>
                    <span className="shrink-0 text-xs text-muted-foreground">{dateTimeLabel(createdAt)}</span>
                </span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">{item.body}</span>
            </span>
            {(onActivate || href) ? <ExternalLink aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground"/> : null}
        </>
    );
    const className = `flex w-full gap-3 border-b px-4 py-4 text-left last:border-b-0 ${unread ? 'bg-primary/5' : ''}`;
    const main = href ? (
        <a href={href} data-unread={unread} onClick={onActivate} className={`${className} hover:bg-muted/45`}>
            {content}
        </a>
    ) : onActivate ? (
        <button type="button" data-unread={unread} onClick={onActivate} className={`${className} hover:bg-muted/45`}>
            {content}
        </button>
    ) : (
        <article data-unread={unread} className={className}>{content}</article>
    );
    if (!onDismiss) return main;
    return (
        <div className="relative border-b last:border-b-0">
            <div className="[&>*]:border-b-0 [&>*]:pr-14">{main}</div>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="본 알림으로 처리"
                title="본 알림으로 처리"
                disabled={dismissing}
                onClick={onDismiss}
                className="absolute right-3 top-1/2 -translate-y-1/2"
            >
                <Check aria-hidden="true" className="size-4"/>
            </Button>
        </div>
    );
}

export function NotificationPanelContent({seenMobileIds, onMobileNotificationSeen}: {
    seenMobileIds: ReadonlySet<string>;
    onMobileNotificationSeen: (id: string) => void;
}) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const notifications = useNotificationsQuery();
    const desktop = platform.capabilities.localNotifications;
    const authenticationRequired = notifications.isError
        && accountAuthenticationRequired(notifications.error);
    const [deliveryMessage, setDeliveryMessage] = useState('');
    const backgroundRefreshFailed = notifications.isError
        && !authenticationRequired
        && notifications.data !== undefined;
    const pushPublicKey = useQuery({
        queryKey: queryKeys.pushPublicKey,
        queryFn: () => api.getPushPublicKey(),
        enabled: !desktop && account.personalAccess.status === 'connected',
        staleTime: 5 * 60_000,
    });

    const registerStartedPush = async (subscriptionPromise: Promise<PushSubscriptionJSON>) => {
        const subscription = await subscriptionPromise;
        await api.registerPushSubscription(subscription);
    };

    const push = useMutation({
        onMutate: () => setDeliveryMessage(''),
        mutationFn: registerStartedPush,
        onSuccess: async () => {
            setDeliveryMessage('이 기기에서 푸시 알림을 받을 수 있습니다.');
            await client.invalidateQueries({queryKey: queryKeys.mobileSessions});
        },
    });

    const testNotification = useMutation({
        onMutate: () => setDeliveryMessage(''),
        mutationFn: async (subscriptionPromise: Promise<PushSubscriptionJSON> | undefined) => {
            if (desktop) return api.sendDesktopTestNotification();
            if (!subscriptionPromise) throw new Error('PUSH_SUBSCRIPTION_NOT_STARTED');
            await registerStartedPush(subscriptionPromise);
            return api.sendMobileTestNotification();
        },
        onSuccess: async (result) => {
            if (desktop && typeof result === 'object' && result !== null && 'snapshot' in result) {
                client.setQueryData(queryKeys.notifications('desktop'), result.snapshot);
                setDeliveryMessage(desktopTestNotificationMessage(result));
            } else {
                setDeliveryMessage(`연결된 모바일 ${String(result)}대의 테스트 푸시를 전송 대기열에 추가했습니다. 1분 안에 도착합니다.`);
                await Promise.all([
                    client.invalidateQueries({queryKey: queryKeys.notifications('browser')}),
                    client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
                ]);
            }
        },
    });

    const connectPush = () => {
        if (!pushPublicKey.data) return;
        testNotification.reset();
        // subscribePush starts permission acquisition synchronously while this
        // click still owns the browser's transient user activation.
        push.mutate(platform.pwa.subscribePush(pushPublicKey.data));
    };

    const sendTestNotification = () => {
        push.reset();
        if (desktop) {
            testNotification.mutate(undefined);
            return;
        }
        if (!pushPublicKey.data) return;
        // Start permission acquisition before React Query enters its async mutation lifecycle.
        testNotification.mutate(platform.pwa.subscribePush(pushPublicKey.data));
    };

    const activate = useMutation({
        mutationFn: (id: string) => api.activateDesktopNotification(id),
        onSuccess: (snapshot) => client.setQueryData(queryKeys.notifications('desktop'), snapshot),
    });

    const markRead = useMutation({
        mutationFn: (id: string) => api.markDesktopNotificationRead(id),
        onMutate: async (id) => {
            await client.cancelQueries({queryKey: queryKeys.notifications('desktop')});
            const previous = client.getQueryData<NotificationInboxSnapshot>(queryKeys.notifications('desktop'));
            if (previous) {
                client.setQueryData(
                    queryKeys.notifications('desktop'),
                    markNotificationInboxItemRead(previous, id, Date.now()),
                );
            }
            return {previous};
        },
        onError: (_error, _id, context) => {
            if (context?.previous) client.setQueryData(queryKeys.notifications('desktop'), context.previous);
        },
        onSuccess: (snapshot) => client.setQueryData(queryKeys.notifications('desktop'), snapshot),
    });

    const content = (() => {
        if (notifications.isPending && !notifications.data) return <LoadingState label="알림함을 불러오고 있습니다."/>;
        if (authenticationRequired) {
            return (
                <Alert>
                    <Smartphone/>
                    <AlertTitle>PC 연결이 필요합니다.</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>기기 연결 화면에서 이 PWA를 PC 앱과 연결하세요.</p>
                        <Button asChild size="sm" variant="outline"><Link to="/connections">기기 연결 열기</Link></Button>
                    </AlertDescription>
                </Alert>
            );
        }
        if (notifications.isError && !notifications.data) return <ErrorState retry={() => void notifications.refetch()}/>;
        const data = notifications.data;
        if (!data) return <EmptyState title="아직 알림이 없습니다."/>;
        const rows = Array.isArray(data) ? data : data.items;
        const renderRows = (history: boolean) => {
            const matching = notificationRowsForTab(rows, seenMobileIds, history ? 'history' : 'new');
            if (matching.length === 0) {
                return <EmptyState title={history ? '지난 알림이 없습니다.' : '새 알림이 없습니다.'}/>;
            }
            return (
                <Card className="gap-0 overflow-hidden py-0">
                    {matching.map((item) => {
                        const mobile = 'createdAtEpochMs' in item;
                        return (
                            <NotificationRow
                                key={item.id}
                                item={item}
                                unread={!history}
                                href={mobile ? item.path : undefined}
                                onActivate={mobile
                                    ? () => onMobileNotificationSeen(item.id)
                                    : () => activate.mutate(item.id)}
                                onDismiss={!history ? (mobile
                                    ? () => onMobileNotificationSeen(item.id)
                                    : () => markRead.mutate(item.id)) : undefined}
                                dismissing={markRead.isPending && markRead.variables === item.id}
                            />
                        );
                    })}
                </Card>
            );
        };
        return (
            <Tabs defaultValue="new" className="gap-3">
                <TabsList aria-label="알림 목록 구분">
                    <TabsTrigger value="new">새 알림</TabsTrigger>
                    <TabsTrigger value="history">지난 알림</TabsTrigger>
                </TabsList>
                <TabsContent value="new">{renderRows(false)}</TabsContent>
                <TabsContent value="history">{renderRows(true)}</TabsContent>
            </Tabs>
        );
    })();

    return (
        <div className="space-y-6">
            <section className="space-y-3" aria-labelledby="notification-inbox-title">
                <h2 className="text-base font-semibold" id="notification-inbox-title">받은 알림</h2>
                {backgroundRefreshFailed ? (
                    <Alert>
                        <Send aria-hidden="true"/>
                        <AlertTitle>최신 알림을 확인하지 못했습니다.</AlertTitle>
                        <AlertDescription className="gap-3">
                            <p>마지막으로 확인한 알림을 표시합니다.</p>
                            <Button size="sm" variant="outline" onClick={() => void notifications.refetch()}>
                                새로고침
                            </Button>
                        </AlertDescription>
                    </Alert>
                ) : null}
                <PersonalAccountGate>{content}</PersonalAccountGate>
            </section>

            {account.personalAccess.status === 'connected' && !authenticationRequired ? (
                <section className="space-y-4 border-t pt-6" aria-labelledby="notification-delivery-title">
                    <div>
                        <h2 className="text-base font-semibold" id="notification-delivery-title">알림 수신</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {desktop ? '이 컴퓨터의 운영체제 알림과 알림함 전달을 확인합니다.' : '이 기기에서 운영체제 푸시 알림을 받습니다.'}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {!desktop ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={connectPush}
                                disabled={push.isPending || testNotification.isPending || !pushPublicKey.data}
                            >
                                <Smartphone aria-hidden="true" className="size-4"/>푸시 연결
                            </Button>
                        ) : null}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={sendTestNotification}
                            disabled={testNotification.isPending || push.isPending || (!desktop && !pushPublicKey.data)}
                        >
                            <Send aria-hidden="true" className="size-4"/>
                            테스트 알림
                        </Button>
                    </div>
                    {(pushPublicKey.isError || push.isError || testNotification.isError) ? (
                        <Alert variant="destructive">
                            <Send aria-hidden="true"/>
                            <AlertTitle>알림을 보내지 못했습니다.</AlertTitle>
                            <AlertDescription>
                                {mobilePushErrorMessage(
                                    testNotification.error ?? push.error ?? pushPublicKey.error,
                                )}
                            </AlertDescription>
                        </Alert>
                    ) : null}
                    {deliveryMessage ? <p aria-live="polite" className="text-sm text-muted-foreground">{deliveryMessage}</p> : null}
                </section>
            ) : null}
        </div>
    );
}
