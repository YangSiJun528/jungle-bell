import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {BellRing, Check, Send, Smartphone} from 'lucide-react';
import {useState} from 'react';

import {
    cleanupPushSubscription,
    loadPushSubscriptionReconciliation,
    PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY,
    type PushSubscriptionCleanupResult,
    type PushSubscriptionLifecycleStorage,
    type PushSubscriptionReconciliation,
} from '@/api/push-subscription-lifecycle';
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

import {notificationPermissionFromRuntime} from '../app-status/app-status-observations';
import {
    assertMobileTestNotificationQueued,
    desktopTestNotificationMessage,
    mobilePushErrorMessage,
} from './notification-result';
import {
    NOTIFICATION_TEST_QUERY_KEY,
    writeNotificationTestRecord,
    type NotificationTestState,
} from './notification-test-history';
import {
    pushDeliveryStepStates,
    reducePushDeliveryState,
    restoredPushDeliveryState,
    type PushDeliveryEvent,
    type PushDeliveryState,
    type PushDeliveryStepId,
    type PushDeliveryStepStatus,
} from './push-delivery-state';
import {
    preparePushSubscriptionRegistration,
    storePushSubscriptionRegistration,
} from './push-registration';
import {SystemNotificationSettingsButton} from './system-notification-settings';

type DesktopArrivalState = 'confirmed' | 'confirming' | 'idle' | 'missing';

const PUSH_DELIVERY_STEP_LABELS: Record<PushDeliveryStepId, string> = {
    permission: '알림 권한',
    'local-subscription': '로컬 푸시 구독',
    'server-registration': '서버 등록',
    'test-send': '테스트 발송',
    arrival: '실제 도착 확인',
};

const PUSH_DELIVERY_STATUS_LABELS: Record<PushDeliveryStepStatus, string> = {
    complete: '완료',
    current: '현재 단계',
    error: '확인 필요',
    waiting: '대기',
};

function pushPermissionDenied(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.message === 'PUSH_PERMISSION_DENIED' || error.name === 'NotAllowedError')
    );
}

function pushSubscriptionStorage(): PushSubscriptionLifecycleStorage {
    try {
        return window.localStorage;
    } catch (error) {
        throw new Error('PUSH_REGISTRATION_STORAGE_UNAVAILABLE', {cause: error});
    }
}

function pushReconciliationMessage(state: PushSubscriptionReconciliation | undefined): string {
    switch (state?.status) {
        case 'matched-registered':
            return '현재 로컬 구독이 이번 서버 등록 응답과 일치합니다.';
        case 'matched-registration-unverified':
            return '저장된 등록 ID와 로컬 구독은 일치하지만 현재 서버 등록은 확인되지 않았습니다. 푸시를 재등록해 확인하세요.';
        case 'matched-server-removed':
            return '서버 등록은 제거됐지만 로컬 구독 해제가 남았습니다. 푸시 끄기를 다시 시도하세요.';
        case 'local-only':
            return '현재 로컬 구독은 있지만 서버 등록 ID가 없습니다. 푸시를 재등록해 복구하세요.';
        case 'record-only':
            return '저장된 서버 등록은 있지만 현재 로컬 구독이 없습니다. 푸시 끄기로 서버 등록을 정리하세요.';
        case 'mismatch':
            return '현재 로컬 구독과 저장된 서버 등록이 다릅니다. 푸시를 재등록해 복구하세요.';
        case 'invalid':
            return '저장된 푸시 등록 정보를 검증하지 못했습니다. 재등록 전 과거 서버 정리는 확인할 수 없습니다.';
        case 'failed':
            return '푸시 등록 정보를 읽거나 현재 구독과 대조하지 못했습니다.';
        default:
            return '';
    }
}

function pushCleanupMessage(result: PushSubscriptionCleanupResult): string {
    if (result.status === 'complete') {
        return '서버 푸시 등록과 이 기기의 로컬 구독을 모두 해제했습니다.';
    }
    if (result.status === 'not-verified') {
        return '저장된 서버 등록 ID가 없어 푸시 정리 완료로 확인하지 않았습니다.';
    }
    switch (result.error.code) {
        case 'registration-id-missing':
            return '로컬 구독은 있지만 서버 등록 ID가 없습니다. 푸시를 재등록한 뒤 다시 끄세요.';
        case 'endpoint-mismatch':
        case 'endpoint-verification-failed':
            return '현재 로컬 구독이 저장된 등록과 달라 중단했습니다. 푸시를 재등록한 뒤 다시 끄세요.';
        case 'server-unregister-failed':
            return '서버 등록을 해제하지 못해 로컬 구독은 유지했습니다. 네트워크를 확인하고 다시 시도하세요.';
        case 'local-unsubscribe-failed':
            return result.error.cause instanceof Error &&
                result.error.cause.message === 'PUSH_SUBSCRIPTION_CHANGED'
                ? '해제 도중 로컬 구독이 바뀌어 새 구독은 건드리지 않았습니다. 현재 상태를 확인한 뒤 다시 시도하세요.'
                : '서버 등록은 해제했지만 로컬 구독 해제에 실패했습니다. 다시 시도하세요.';
        case 'local-unsubscribe-rejected':
            return '서버 등록은 해제했지만 브라우저가 로컬 구독 해제를 완료하지 못했습니다. 다시 시도하세요.';
        default:
            return '푸시 정리가 일부만 끝났습니다. 현재 상태를 확인한 뒤 다시 시도하세요.';
    }
}

function useNotificationDeliverySetup() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const desktop = platform.capabilities.localNotifications;
    const [deliveryMessage, setDeliveryMessage] = useState('');
    const [showSystemSettingsShortcut, setShowSystemSettingsShortcut] = useState(false);
    const [desktopArrival, setDesktopArrival] = useState<DesktopArrivalState>('idle');
    const [pushDeliveryState, setPushDeliveryState] = useState<PushDeliveryState | null>(null);
    const [pushCleanupNeedsRetry, setPushCleanupNeedsRetry] = useState(false);
    const notificationPermission = notificationPermissionFromRuntime(
        typeof Notification === 'undefined' ? undefined : Notification,
    );
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
    const pushLifecycle = useQuery({
        queryKey: PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY,
        queryFn: () =>
            loadPushSubscriptionReconciliation({
                storage: pushSubscriptionStorage(),
                getLocalSubscription: () => platform.pwa.getPushSubscription(),
            }),
        enabled: !desktop && account.personalAccess.status === 'connected',
    });
    const restoredState = restoredPushDeliveryState(
        pushLifecycle.data?.status ?? 'none',
        notificationPermission === 'unsupported' ? 'default' : notificationPermission,
    );
    const effectivePushDeliveryState = pushDeliveryState ?? restoredState;

    const publishNotificationTest = (state: NotificationTestState) => {
        const recordInput = {
            surface: desktop ? ('pc' as const) : ('pwa' as const),
            state,
            testedAt: new Date().toISOString(),
        };
        let record = {version: 1 as const, ...recordInput};
        try {
            record = writeNotificationTestRecord(pushSubscriptionStorage(), recordInput);
        } catch {
            // Query cache still shares the current-session result when storage is unavailable.
        }
        client.setQueryData(NOTIFICATION_TEST_QUERY_KEY, record);
    };

    const transitionPushDelivery = (event: PushDeliveryEvent) => {
        setPushDeliveryState((state) => reducePushDeliveryState(state ?? restoredState, event));
    };

    const registerStartedPush = async (subscriptionPromise: Promise<PushSubscriptionJSON>) => {
        let subscription: PushSubscriptionJSON;
        try {
            subscription = await subscriptionPromise;
            transitionPushDelivery({type: 'local-subscribed'});
        } catch (error) {
            transitionPushDelivery({
                type: pushPermissionDenied(error)
                    ? 'permission-denied'
                    : 'local-subscription-failed',
            });
            throw error;
        }

        try {
            const storage = pushSubscriptionStorage();
            const preparation = await preparePushSubscriptionRegistration({
                storage,
                subscription,
                unregisterServer: (subscriptionId) =>
                    api.unregisterPushSubscription(subscriptionId),
            });
            const subscriptionId = await api.registerPushSubscription(subscription);
            const metadata = await storePushSubscriptionRegistration({
                storage,
                subscription,
                subscriptionId,
            });
            client.setQueryData(PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY, {
                status: 'matched-registered',
                metadata,
                serverEvidence: 'registration-response',
            } satisfies PushSubscriptionReconciliation);
            transitionPushDelivery({type: 'server-registered'});
            return preparation;
        } catch (error) {
            transitionPushDelivery({type: 'server-registration-failed'});
            void client.invalidateQueries({queryKey: PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY});
            throw error;
        }
    };

    const push = useMutation({
        onMutate: () => {
            setDeliveryMessage('');
            transitionPushDelivery({type: 'connection-started'});
        },
        mutationFn: registerStartedPush,
        onSuccess: async (result) => {
            setPushCleanupNeedsRetry(false);
            setDeliveryMessage(
                result.priorCleanup === 'unverified'
                    ? '현재 푸시 구독은 서버에 등록했습니다. 손상된 이전 등록 정보의 서버 정리 여부는 확인하지 못했습니다.'
                    : '이 기기의 푸시 구독을 서버에 등록했습니다. 테스트 알림을 보내 실제 도착을 확인하세요.',
            );
            await client.invalidateQueries({queryKey: queryKeys.mobileSessions});
        },
    });

    const disablePush = useMutation({
        onMutate: () => {
            setDeliveryMessage('');
            setPushCleanupNeedsRetry(false);
        },
        mutationFn: () =>
            cleanupPushSubscription({
                storage: pushSubscriptionStorage(),
                getLocalSubscription: () => platform.pwa.getPushSubscription(),
                unregisterServer: (subscriptionId) =>
                    api.unregisterPushSubscription(subscriptionId),
                unsubscribeLocal: (subscription) => {
                    if (typeof subscription.endpoint !== 'string' || !subscription.endpoint) {
                        throw new Error('PUSH_SUBSCRIPTION_ENDPOINT_INVALID');
                    }
                    return platform.pwa.unsubscribePush(subscription.endpoint);
                },
            }),
        onSuccess: async (result) => {
            setPushDeliveryState(null);
            setPushCleanupNeedsRetry(result.status === 'incomplete');
            setDeliveryMessage(pushCleanupMessage(result));
            await pushLifecycle.refetch();
        },
    });

    const testNotification = useMutation({
        onMutate: () => {
            setDeliveryMessage('');
            setShowSystemSettingsShortcut(false);
            setDesktopArrival('idle');
            publishNotificationTest({status: 'test-sending'});
            if (!desktop) transitionPushDelivery({type: 'test-started'});
        },
        mutationFn: async (subscriptionPromise: Promise<PushSubscriptionJSON> | undefined) => {
            if (desktop) return api.sendDesktopTestNotification();
            if (!subscriptionPromise) throw new Error('PUSH_SUBSCRIPTION_NOT_STARTED');
            await registerStartedPush(subscriptionPromise);
            transitionPushDelivery({type: 'test-started'});
            try {
                return assertMobileTestNotificationQueued(await api.sendMobileTestNotification());
            } catch (error) {
                transitionPushDelivery({type: 'test-failed'});
                throw error;
            }
        },
        onSuccess: async (result) => {
            if (desktop && typeof result === 'object' && result !== null && 'snapshot' in result) {
                client.setQueryData(queryKeys.notifications('desktop'), result.snapshot);
                setDeliveryMessage(desktopTestNotificationMessage(result));
                setShowSystemSettingsShortcut(!result.systemDelivered);
                setDesktopArrival(result.systemDelivered ? 'confirming' : 'missing');
                if (!result.systemDelivered) {
                    publishNotificationTest({status: 'not-arrived'});
                }
            } else if (typeof result === 'number') {
                transitionPushDelivery({type: 'test-queued', queued: result});
                setDeliveryMessage(
                    `연결된 모바일 ${result}대의 테스트 푸시를 전송 대기열에 추가했습니다. 도착까지 최대 1분 정도 걸릴 수 있으며, 실제 도착을 아래에서 확인해야 합니다.`,
                );
                await Promise.all([
                    client.invalidateQueries({queryKey: queryKeys.notifications('browser')}),
                    client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
                ]);
            } else {
                throw new Error('TEST_NOTIFICATION_RESULT_INVALID');
            }
        },
        onError: () => publishNotificationTest({status: 'error'}),
    });

    const connectPush = () => {
        if (!pushSetup.data) return;
        testNotification.reset();
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
        desktopArrival,
        pushDeliveryState: effectivePushDeliveryState,
        pushRegistered: effectivePushDeliveryState.serverRegistration === 'complete',
        pushCleanupNeedsRetry,
        confirmDesktopArrival: () => {
            setDesktopArrival('confirmed');
            publishNotificationTest({status: 'arrived'});
        },
        reportDesktopArrivalMissing: () => {
            setDesktopArrival('missing');
            setShowSystemSettingsShortcut(true);
            publishNotificationTest({status: 'not-arrived'});
        },
        confirmMobileArrival: () => {
            transitionPushDelivery({type: 'arrival-confirmed'});
            publishNotificationTest({status: 'arrived'});
        },
        reportMobileArrivalMissing: () => {
            transitionPushDelivery({type: 'arrival-missing'});
            publishNotificationTest({status: 'not-arrived'});
        },
        connectPush,
        reregisterPush: connectPush,
        disablePush: () => disablePush.mutate(),
        sendTestNotification,
        retryPushSetup: () => void pushSetup.refetch(),
        preparingPush: !desktop && (pushSetup.isFetching || pushLifecycle.isFetching),
        pushSetupError: pushSetup.error,
        pushReady: desktop || Boolean(pushSetup.data),
        busy: push.isPending || testNotification.isPending || disablePush.isPending,
        error: testNotification.error ?? push.error ?? disablePush.error ?? pushSetup.error,
        pushLifecycleError: pushLifecycle.error,
        pushLifecycleMessage: pushReconciliationMessage(pushLifecycle.data),
    };
}

type NotificationDelivery = ReturnType<typeof useNotificationDeliverySetup>;

function PushDeliverySteps({state}: {state: PushDeliveryState}) {
    const steps = pushDeliveryStepStates(state);

    return (
        <ol aria-label="푸시 알림 연결 단계" className="grid gap-2 sm:grid-cols-5">
            {steps.map((step, index) => (
                <li
                    key={step.id}
                    aria-current={step.status === 'current' ? 'step' : undefined}
                    data-status={step.status}
                    className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs sm:flex-col sm:items-start"
                >
                    <span
                        aria-hidden="true"
                        className={`grid size-5 shrink-0 place-items-center rounded-full text-[0.65rem] font-bold ${
                            step.status === 'complete'
                                ? 'bg-primary text-primary-foreground'
                                : step.status === 'error'
                                  ? 'bg-destructive text-white'
                                  : step.status === 'current'
                                    ? 'bg-primary/15 text-primary'
                                    : 'bg-muted text-muted-foreground'
                        }`}
                    >
                        {step.status === 'complete' ? <Check className="size-3" /> : index + 1}
                    </span>
                    <span className="min-w-0">
                        <strong className="block leading-4">
                            {PUSH_DELIVERY_STEP_LABELS[step.id]}
                        </strong>
                        <span className="text-muted-foreground">
                            {PUSH_DELIVERY_STATUS_LABELS[step.status]}
                        </span>
                    </span>
                </li>
            ))}
        </ol>
    );
}

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
    if (delivery.desktop) {
        return <NotificationTestButton delivery={delivery} label="테스트 알림" />;
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={delivery.reregisterPush}
                    disabled={delivery.busy || !delivery.pushReady}
                >
                    <Smartphone aria-hidden="true" className="size-4" />
                    {delivery.pushRegistered ? '푸시 재등록' : '푸시 연결'}
                </Button>
                <NotificationTestButton delivery={delivery} label="테스트 알림" />
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={delivery.disablePush}
                    disabled={delivery.busy}
                >
                    {delivery.pushCleanupNeedsRetry ? '푸시 끄기 다시 시도' : '푸시 끄기'}
                </Button>
            </div>
            <div role="note" className="space-y-1 text-xs leading-5 text-muted-foreground">
                <p>서버 등록을 먼저 해제한 뒤 같은 로컬 구독인지 다시 확인하고 제거합니다.</p>
                <p>알림 권한은 브라우저 또는 기기 설정의 Jungle Bell 항목에서 변경하세요.</p>
            </div>
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
    if (delivery.pushLifecycleError && !delivery.error) {
        return (
            <Alert variant="destructive">
                <Smartphone aria-hidden="true" />
                <AlertTitle>푸시 상태를 확인하지 못했습니다.</AlertTitle>
                <AlertDescription>페이지를 새로고침한 뒤 다시 시도하세요.</AlertDescription>
            </Alert>
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
    const message = delivery.deliveryMessage || delivery.pushLifecycleMessage;
    if (!message) return null;
    return (
        <p aria-live="polite" className="text-sm text-muted-foreground">
            {message}
        </p>
    );
}

function NotificationArrivalConfirmation({
    delivery,
    onComplete,
}: {
    delivery: NotificationDelivery;
    onComplete?: () => void;
}) {
    if (delivery.desktop) {
        if (delivery.desktopArrival === 'confirming') {
            return (
                <Alert>
                    <BellRing aria-hidden="true" />
                    <AlertTitle>PC 테스트 알림이 실제로 보였나요?</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>운영체제 표시 호출은 성공했습니다. 화면에서 본 결과를 선택하세요.</p>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                    delivery.confirmDesktopArrival();
                                    onComplete?.();
                                }}
                            >
                                보였어요
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={delivery.reportDesktopArrivalMissing}
                            >
                                보이지 않았어요
                            </Button>
                        </div>
                    </AlertDescription>
                </Alert>
            );
        }
        if (delivery.desktopArrival === 'missing') {
            return (
                <Alert variant="destructive" aria-live="polite">
                    <Send aria-hidden="true" />
                    <AlertTitle>운영체제 알림을 표시하지 못했습니다.</AlertTitle>
                    <AlertDescription className="gap-3">
                        <p>알림 권한과 집중 모드를 확인한 뒤 테스트를 다시 보내세요.</p>
                        {delivery.showSystemSettingsShortcut ? (
                            <SystemNotificationSettingsButton />
                        ) : null}
                        <NotificationTestButton delivery={delivery} label="테스트 다시 보내기" />
                    </AlertDescription>
                </Alert>
            );
        }
        if (delivery.desktopArrival === 'confirmed') {
            return (
                <p aria-live="polite" className="text-sm text-emerald-700 dark:text-emerald-300">
                    PC 테스트 알림의 실제 도착을 확인했습니다.
                </p>
            );
        }
        return null;
    }

    if (delivery.pushDeliveryState.arrival === 'current') {
        return (
            <Alert>
                <BellRing aria-hidden="true" />
                <AlertTitle>테스트 알림이 실제로 도착했나요?</AlertTitle>
                <AlertDescription className="gap-3">
                    <p>최대 1분 정도 걸릴 수 있습니다. 화면을 닫아도 알림이 와야 합니다.</p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                                delivery.confirmMobileArrival();
                                onComplete?.();
                            }}
                        >
                            도착했어요
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={delivery.reportMobileArrivalMissing}
                        >
                            도착하지 않았어요
                        </Button>
                    </div>
                </AlertDescription>
            </Alert>
        );
    }
    if (delivery.pushDeliveryState.arrival === 'error') {
        return (
            <Alert variant="destructive">
                <Smartphone aria-hidden="true" />
                <AlertTitle>휴대폰 알림 설정을 확인해 주세요.</AlertTitle>
                <AlertDescription className="gap-3">
                    <p>
                        Jungle Bell 알림 권한과 집중 모드를 확인하세요. 재등록을 먼저 시도하거나
                        테스트 알림을 실제로 다시 보낼 수 있습니다.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={delivery.sendTestNotification}
                        >
                            테스트 다시 보내기
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={delivery.reregisterPush}
                        >
                            푸시 재등록
                        </Button>
                    </div>
                </AlertDescription>
            </Alert>
        );
    }
    if (delivery.pushDeliveryState.arrival === 'complete') {
        return (
            <p aria-live="polite" className="text-sm text-emerald-700 dark:text-emerald-300">
                테스트 푸시의 실제 도착을 확인했습니다.
            </p>
        );
    }
    return null;
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
            {!delivery.desktop ? <PushDeliverySteps state={delivery.pushDeliveryState} /> : null}
            <NotificationDeliveryActions delivery={delivery} />
            <NotificationDeliveryFeedback delivery={delivery} />
            <NotificationArrivalConfirmation delivery={delivery} />
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
                        ? '테스트 알림을 보내 PC의 운영체제 알림이 실제로 보이는지 확인합니다.'
                        : '푸시를 연결하고 테스트 알림이 휴대폰에 실제로 도착하는지 확인합니다.'}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {!delivery.desktop ? (
                    <PushDeliverySteps state={delivery.pushDeliveryState} />
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <NotificationTestButton
                        delivery={delivery}
                        label={delivery.desktop ? '테스트 알림' : '알림 연결하고 테스트'}
                    />
                </div>
                <NotificationDeliveryFeedback delivery={delivery} />
                <NotificationArrivalConfirmation delivery={delivery} onComplete={onComplete} />
            </CardContent>
            <CardFooter>
                <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
                    나중에
                </Button>
            </CardFooter>
        </Card>
    );
}
