import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {BellRing, Check, Send, Smartphone} from 'lucide-react';
import {useState} from 'react';

import {useDashboardAccount} from '@/app/dashboard-account';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

import {desktopTestNotificationMessage, mobilePushErrorMessage} from './notification-result';
import {SystemNotificationSettingsButton} from './system-notification-settings';

type MobileArrivalState = 'idle' | 'confirming' | 'missing';

function useNotificationDeliverySetup() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const desktop = platform.capabilities.localNotifications;
    const [deliveryMessage, setDeliveryMessage] = useState('');
    const [showSystemSettingsShortcut, setShowSystemSettingsShortcut] = useState(false);
    const [desktopDeliveryConfirmed, setDesktopDeliveryConfirmed] = useState(false);
    const [mobileArrival, setMobileArrival] = useState<MobileArrivalState>('idle');
    const pushSetup = useQuery({
        queryKey: queryKeys.pushSetup,
        queryFn: async () => {
            const [applicationServerKey] = await Promise.all([
                api.getPushPublicKey(),
                platform.pwa.preparePush(),
            ]);
            return applicationServerKey;
        },
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
        onMutate: () => {
            setDeliveryMessage('');
            setShowSystemSettingsShortcut(false);
            setDesktopDeliveryConfirmed(false);
            setMobileArrival('idle');
        },
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
                setShowSystemSettingsShortcut(!result.systemDelivered);
                setDesktopDeliveryConfirmed(result.systemDelivered);
            } else {
                setDeliveryMessage(
                    `연결된 모바일 ${String(result)}대의 테스트 푸시를 전송 대기열에 추가했습니다. 1분 안에 도착합니다.`,
                );
                setMobileArrival('confirming');
                await Promise.all([
                    client.invalidateQueries({queryKey: queryKeys.notifications('browser')}),
                    client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
                ]);
            }
        },
    });

    const connectPush = () => {
        if (!pushSetup.data) return;
        testNotification.reset();
        setMobileArrival('idle');
        // Start the browser subscription synchronously while this click still
        // owns the browser's transient user activation.
        push.mutate(platform.pwa.subscribePush(pushSetup.data));
    };

    const sendTestNotification = () => {
        push.reset();
        if (desktop) {
            testNotification.mutate(undefined);
            return;
        }
        if (!pushSetup.data) return;
        // Start the browser subscription before React Query enters its async mutation lifecycle.
        testNotification.mutate(platform.pwa.subscribePush(pushSetup.data));
    };

    return {
        desktop,
        deliveryMessage,
        showSystemSettingsShortcut,
        desktopDeliveryConfirmed,
        mobileArrival,
        setMobileArrival,
        connectPush,
        sendTestNotification,
        retryPushSetup: () => void pushSetup.refetch(),
        preparingPush: !desktop && pushSetup.isFetching,
        pushSetupError: pushSetup.error,
        pushReady: desktop || Boolean(pushSetup.data),
        busy: push.isPending || testNotification.isPending,
        error: testNotification.error ?? push.error ?? pushSetup.error,
    };
}

type NotificationDelivery = ReturnType<typeof useNotificationDeliverySetup>;

function NotificationTestButton({
    delivery,
    label,
}: {
    delivery: NotificationDelivery;
    label: string;
}) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={delivery.sendTestNotification}
            disabled={delivery.busy || !delivery.pushReady}
        >
            <Send aria-hidden="true" className="size-4" />
            {delivery.busy ? '확인 중' : label}
        </Button>
    );
}

function NotificationDeliveryActions({delivery}: {delivery: NotificationDelivery}) {
    return (
        <div className="flex flex-wrap gap-2">
            {!delivery.desktop ? (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={delivery.connectPush}
                    disabled={delivery.busy || !delivery.pushReady}
                >
                    <Smartphone aria-hidden="true" className="size-4" />
                    푸시 연결
                </Button>
            ) : null}
            <NotificationTestButton delivery={delivery} label="테스트 알림" />
        </div>
    );
}

function NotificationDeliveryFeedback({delivery}: {delivery: NotificationDelivery}) {
    if (delivery.preparingPush) {
        return (
            <p aria-live="polite" className="text-sm text-muted-foreground">
                푸시 기능을 준비하고 있습니다.
            </p>
        );
    }
    if (delivery.error) {
        return (
            <Alert variant="destructive">
                <Send aria-hidden="true" />
                <AlertTitle>알림을 보내지 못했습니다.</AlertTitle>
                <AlertDescription className="gap-3">
                    <p>
                        {delivery.desktop
                            ? 'PC 테스트 알림을 보내지 못했습니다. 잠시 후 다시 시도하세요.'
                            : mobilePushErrorMessage(delivery.error)}
                    </p>
                    {delivery.pushSetupError ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={delivery.retryPushSetup}
                        >
                            푸시 다시 준비
                        </Button>
                    ) : null}
                </AlertDescription>
            </Alert>
        );
    }
    if (!delivery.deliveryMessage) return null;
    if (delivery.showSystemSettingsShortcut) {
        return (
            <Alert variant="destructive" aria-live="polite">
                <Send aria-hidden="true" />
                <AlertTitle>운영체제 알림을 표시하지 못했습니다.</AlertTitle>
                <AlertDescription className="gap-3">
                    <p>{delivery.deliveryMessage}</p>
                    <SystemNotificationSettingsButton />
                </AlertDescription>
            </Alert>
        );
    }
    return (
        <p aria-live="polite" className="text-sm text-muted-foreground">
            {delivery.deliveryMessage}
        </p>
    );
}

export function NotificationDeliverySection() {
    const delivery = useNotificationDeliverySetup();

    return (
        <section className="space-y-4 border-t pt-6" aria-labelledby="notification-delivery-title">
            <div>
                <h2 className="text-base font-semibold" id="notification-delivery-title">
                    알림 수신
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    {delivery.desktop
                        ? '이 컴퓨터의 운영체제 알림과 알림함 전달을 확인합니다.'
                        : '이 기기에서 운영체제 푸시 알림을 받습니다.'}
                </p>
            </div>
            <NotificationDeliveryActions delivery={delivery} />
            <NotificationDeliveryFeedback delivery={delivery} />
        </section>
    );
}

export function NotificationOnboardingCard({
    onComplete,
    onSkip,
}: {
    onComplete: () => void;
    onSkip: () => void;
}) {
    const delivery = useNotificationDeliverySetup();

    return (
        <Card data-notification-onboarding="true">
            <CardHeader>
                <span className="mb-1 grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                    <BellRing aria-hidden="true" className="size-4.5" />
                </span>
                <CardTitle>알림 확인 (선택)</CardTitle>
                <CardDescription>
                    {delivery.desktop
                        ? '테스트 알림을 보내 PC의 운영체제 알림이 보이는지 확인합니다.'
                        : '푸시를 연결하고 테스트 알림이 휴대폰에 실제로 도착하는지 확인합니다.'}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                    <NotificationTestButton
                        delivery={delivery}
                        label={delivery.desktop ? '테스트 알림' : '알림 연결하고 테스트'}
                    />
                </div>
                <NotificationDeliveryFeedback delivery={delivery} />

                {delivery.desktopDeliveryConfirmed ? (
                    <Button type="button" size="sm" onClick={onComplete}>
                        <Check aria-hidden="true" className="size-4" />
                        알림 확인 완료
                    </Button>
                ) : null}

                {!delivery.desktop && delivery.mobileArrival === 'confirming' ? (
                    <Alert>
                        <BellRing aria-hidden="true" />
                        <AlertTitle>테스트 알림이 실제로 도착했나요?</AlertTitle>
                        <AlertDescription className="gap-3">
                            <p>최대 1분 정도 걸릴 수 있습니다. 화면을 닫아도 알림이 와야 합니다.</p>
                            <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={onComplete}>
                                    도착했어요
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => delivery.setMobileArrival('missing')}
                                >
                                    도착하지 않았어요
                                </Button>
                            </div>
                        </AlertDescription>
                    </Alert>
                ) : null}

                {!delivery.desktop && delivery.mobileArrival === 'missing' ? (
                    <Alert variant="destructive">
                        <Smartphone aria-hidden="true" />
                        <AlertTitle>휴대폰 알림 설정을 확인해 주세요.</AlertTitle>
                        <AlertDescription className="gap-2">
                            <p>
                                Jungle Bell 알림 권한과 집중 모드를 확인한 뒤 테스트 알림을 다시
                                보내세요.
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => delivery.setMobileArrival('idle')}
                            >
                                다시 시도
                            </Button>
                        </AlertDescription>
                    </Alert>
                ) : null}
            </CardContent>
            <CardFooter>
                <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
                    나중에
                </Button>
            </CardFooter>
        </Card>
    );
}
