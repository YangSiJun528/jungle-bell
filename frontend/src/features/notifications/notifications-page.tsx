import {useMutation, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {Check, CheckCheck, ExternalLink, Send, Smartphone} from 'lucide-react';
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
    markAllNotificationInboxItemsRead,
    markNotificationInboxItemRead,
    type NotificationInboxItem,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';
import {NotificationDeliverySection} from './notification-delivery-setup';
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

export function NotificationPanelContent({seenMobileIds, onMobileNotificationsSeen}: {
    seenMobileIds: ReadonlySet<string>;
    onMobileNotificationsSeen: (ids: readonly string[]) => void;
}) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const notifications = useNotificationsQuery();
    const desktop = platform.capabilities.localNotifications;
    const authenticationRequired = notifications.isError
        && accountAuthenticationRequired(notifications.error);
    const backgroundRefreshFailed = notifications.isError
        && !authenticationRequired
        && notifications.data !== undefined;

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

    const markAllRead = useMutation({
        mutationFn: () => api.markAllDesktopNotificationsRead(),
        onMutate: async () => {
            await client.cancelQueries({queryKey: queryKeys.notifications('desktop')});
            const previous = client.getQueryData<NotificationInboxSnapshot>(queryKeys.notifications('desktop'));
            if (previous) {
                client.setQueryData(
                    queryKeys.notifications('desktop'),
                    markAllNotificationInboxItemsRead(previous, Date.now()),
                );
            }
            return {previous};
        },
        onError: (_error, _variables, context) => {
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
        const newRows = notificationRowsForTab(rows, seenMobileIds, 'new');
        const historyRows = notificationRowsForTab(rows, seenMobileIds, 'history');
        const renderRows = (
            matching: Array<DashboardNotification | NotificationInboxItem>,
            history: boolean,
        ) => {
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
                                    ? () => onMobileNotificationsSeen([item.id])
                                    : () => activate.mutate(item.id)}
                                onDismiss={!history ? (mobile
                                    ? () => onMobileNotificationsSeen([item.id])
                                    : () => markRead.mutate(item.id)) : undefined}
                                dismissing={markAllRead.isPending
                                    || (markRead.isPending && markRead.variables === item.id)}
                            />
                        );
                    })}
                </Card>
            );
        };
        const markAllNewNotifications = () => {
            if (desktop) {
                markAllRead.mutate();
                return;
            }
            const mobileIds = newRows.flatMap((item) => 'createdAtEpochMs' in item ? [item.id] : []);
            onMobileNotificationsSeen(mobileIds);
        };
        return (
            <Tabs defaultValue="new" className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <TabsList aria-label="알림 목록 구분">
                        <TabsTrigger value="new">새 알림</TabsTrigger>
                        <TabsTrigger value="history">지난 알림</TabsTrigger>
                    </TabsList>
                    {newRows.length > 0 ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={markAllRead.isPending || markRead.isPending}
                            onClick={markAllNewNotifications}
                        >
                            <CheckCheck aria-hidden="true" className="size-4"/>모두 읽음
                        </Button>
                    ) : null}
                </div>
                <TabsContent value="new">{renderRows(newRows, false)}</TabsContent>
                <TabsContent value="history">{renderRows(historyRows, true)}</TabsContent>
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
                <NotificationDeliverySection/>
            ) : null}
        </div>
    );
}
