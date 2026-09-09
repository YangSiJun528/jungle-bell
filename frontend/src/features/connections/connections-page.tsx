import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';
import {
    CircleAlert,
    KeyRound,
    Link2,
    MonitorCheck,
    QrCode,
    RotateCcw,
    Smartphone,
    Trash2,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';

import type {
    MobilePairingCreated,
    MobilePairingStatus,
    MobileSession,
    PairingClaim,
} from '@/api/dashboard-api';
import {
    cleanupPushSubscription,
    type PushSubscriptionCleanupResult,
    type PushSubscriptionLifecycleStorage,
} from '@/api/push-subscription-lifecycle';
import {useDashboardAccount} from '@/app/dashboard-account';
import {
    assertLmsAuthenticated,
    assertServerSessionReady,
    serverSessionReady,
} from '@/app/dashboard-account-state';
import {
    queryKeys,
    refreshBrowserPersonalQueries,
    removeBrowserPersonalQueries,
    removeDesktopIdentityQueries,
    useDashboardEnvironment,
} from '@/app/dashboard-context';
import {readInitialPairingEntry} from '@/app/pairing-bootstrap';
import {PersonalAccountGate} from '@/app/personal-account-gate';
import {
    normalizeConnectionsSearch,
    type ConnectionsTab,
    type DashboardReturnTarget,
} from '@/app/routes';
import {NotificationSettings} from '@/app/settings/notification-settings';
import {useDesktopConnectionQuery, useRefreshAttendanceMutation} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
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
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {
    formatManualPairingCode,
    validManualPairingCode,
} from '@/domain/connections/manual-pairing-code';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';

import {disconnectCompanionWithPushCleanup} from './companion-disconnect';
import {
    CompanionDisconnectFeedbackPanel,
    type CompanionDisconnectFeedback,
} from './companion-disconnect-feedback';
import {desktopConnectionUiState, type DesktopConnectionUiState} from './desktop-connection-state';
import {releaseExclusiveAction, tryReserveExclusiveAction} from './exclusive-action';
import {pairingQrDataUrl} from './lib/pairing-qr';
import {
    clearPendingMobilePairing,
    readPendingMobilePairing,
    storePendingMobilePairing,
} from './lib/pending-pairing';
import {mobileDeviceLabel, mobileInstallationId} from './mobile-identity';
import {PairingExpiryCountdown} from './pairing-expiry-countdown';
import {
    automaticPairingAction,
    finishCompanionPairing,
    releasePairingStart,
    tryReservePairingStart,
    waitForPairingCompletion,
    type CompanionCompletionPath,
} from './pairing-flow';
import {ServiceSettings} from './service-settings';

interface PairingClaimStart {
    mode: 'handoff' | 'manual' | 'qr' | 'resume';
    resumePairingId?: string;
    signal?: AbortSignal;
}

function pairingPersistentStorage(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        try {
            return window.sessionStorage;
        } catch {
            return null;
        }
    }
}

function pushSubscriptionStorage(): PushSubscriptionLifecycleStorage {
    try {
        return window.localStorage;
    } catch (error) {
        throw new Error('PUSH_REGISTRATION_STORAGE_UNAVAILABLE', {cause: error});
    }
}

type MutationState<TData, TVariables> = Pick<
    UseMutationResult<TData, Error, TVariables>,
    'isError' | 'isPending' | 'mutate'
>;

type PairingStatusQuery = Pick<UseQueryResult<MobilePairingStatus>, 'data' | 'isError' | 'refetch'>;

type MobileSessionsQuery = Pick<
    UseQueryResult<MobileSession[]>,
    'isError' | 'isPending' | 'refetch'
>;

interface MobilePairingCardProps {
    approve: MutationState<void, void>;
    cancelPairing: () => void;
    connectionUi: DesktopConnectionUiState;
    createPairing: MutationState<MobilePairingCreated, void>;
    pairing: MobilePairingCreated | null;
    pairingMessage: string;
    pairingStatus: PairingStatusQuery;
    personalReady: boolean;
    qr: string | null;
    registersDesktop: boolean;
}

function MobilePairingCard({
    approve,
    cancelPairing,
    connectionUi,
    createPairing,
    pairing,
    pairingMessage,
    pairingStatus,
    personalReady,
    qr,
    registersDesktop,
}: MobilePairingCardProps) {
    const pairingExpired = pairingStatus.data?.status === 'expired';
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <QrCode className="size-5" />
                    휴대폰 설정
                </CardTitle>
                <CardDescription>
                    스캔하면 PC 연결, 앱 설치, 알림 설정을 순서대로 안내합니다.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {!personalReady || !connectionUi.canCreatePairing ? (
                    <p className="text-sm text-muted-foreground">
                        LMS 로그인과 계정 연결 후 코드를 만들 수 있습니다.
                    </p>
                ) : !pairing ? (
                    <div className="space-y-3">
                        <Button
                            onClick={() => createPairing.mutate()}
                            disabled={createPairing.isPending || !connectionUi.canCreatePairing}
                        >
                            <Link2 className="size-4" />
                            {registersDesktop
                                ? 'PC 등록 및 휴대폰 설정 시작'
                                : '휴대폰 설정 QR 만들기'}
                        </Button>
                        {createPairing.isError ? (
                            <p className="text-sm text-destructive">
                                연결 코드를 만들지 못했습니다. 잠시 후 다시 시도하세요.
                            </p>
                        ) : null}
                    </div>
                ) : pairingExpired ? (
                    <Alert variant="destructive">
                        <CircleAlert aria-hidden="true" />
                        <AlertTitle>연결 코드가 만료됐습니다.</AlertTitle>
                        <AlertDescription className="gap-3">
                            <p>만료된 QR과 코드는 더 이상 사용할 수 없습니다.</p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => createPairing.mutate()}
                                disabled={createPairing.isPending}
                            >
                                {createPairing.isPending
                                    ? '새 코드 만드는 중'
                                    : '새 QR과 코드 만들기'}
                            </Button>
                        </AlertDescription>
                    </Alert>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
                        {qr ? (
                            <img
                                src={qr}
                                alt="휴대폰 설정 시작 QR 코드"
                                className="aspect-square w-36 rounded-lg border bg-white p-2"
                            />
                        ) : null}
                        <div className="min-w-0 space-y-3">
                            <div>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-xs text-muted-foreground">
                                        10자리 연결 코드
                                    </p>
                                    <PairingExpiryCountdown expiresAt={pairing.expiresAt} />
                                </div>
                                <p className="mt-1 font-mono text-2xl font-bold tracking-wider">
                                    {formatManualPairingCode(pairing.manualCode)}
                                </p>
                            </div>
                            {pairingStatus.data?.status === 'completed' ? (
                                <p
                                    aria-live="polite"
                                    className="text-sm text-emerald-700 dark:text-emerald-300"
                                >
                                    연결이 완료됐습니다.
                                </p>
                            ) : null}
                            {pairingStatus.data?.claim ? (
                                <Alert>
                                    <KeyRound />
                                    <AlertTitle>{pairingStatus.data.claim.deviceLabel}</AlertTitle>
                                    <AlertDescription>
                                        <span>
                                            확인 번호 {pairingStatus.data.claim.confirmationCode}
                                        </span>
                                        <Button
                                            className="mt-2 max-w-full"
                                            size="sm"
                                            onClick={() => approve.mutate()}
                                            disabled={approve.isPending}
                                        >
                                            이 휴대폰 승인
                                        </Button>
                                    </AlertDescription>
                                </Alert>
                            ) : null}
                            {pairingStatus.isError ? (
                                <div className="space-y-2 text-sm text-destructive">
                                    <p>연결 상태를 확인하지 못했습니다.</p>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void pairingStatus.refetch()}
                                    >
                                        새로고침
                                    </Button>
                                </div>
                            ) : null}
                            {approve.isError ? (
                                <p className="text-sm text-destructive">
                                    이 기기를 승인하지 못했습니다.
                                </p>
                            ) : null}
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => createPairing.mutate()}
                                    disabled={createPairing.isPending || approve.isPending}
                                >
                                    {createPairing.isPending ? '코드 변경 중' : '코드 변경'}
                                </Button>
                                {pairingStatus.data?.status !== 'completed' ? (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={cancelPairing}
                                        disabled={createPairing.isPending || approve.isPending}
                                    >
                                        연결 대기 취소
                                    </Button>
                                ) : null}
                            </div>
                            {createPairing.isError ? (
                                <p className="text-sm text-destructive">
                                    새 연결 코드를 만들지 못했습니다.
                                </p>
                            ) : null}
                        </div>
                    </div>
                )}
                {pairingMessage ? (
                    <p aria-live="polite" className="text-sm text-muted-foreground">
                        {pairingMessage}
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}

function ConnectedMobileCard({
    activeSessions,
    personalReady,
    revoke,
    sessions,
}: {
    activeSessions: MobileSession[];
    personalReady: boolean;
    revoke: MutationState<void, string>;
    sessions: MobileSessionsQuery;
}) {
    const [revokeTarget, setRevokeTarget] = useState<MobileSession | null>(null);
    const [revokeFeedback, setRevokeFeedback] = useState<{
        kind: 'success' | 'error';
        session: MobileSession;
    } | null>(null);
    const revokeInFlight = useRef({inFlight: false});
    const confirmRevoke = () => {
        const target = revokeTarget;
        if (!target || !tryReserveExclusiveAction(revokeInFlight.current)) return;
        setRevokeFeedback(null);
        revoke.mutate(target.deviceId, {
            onSuccess: () => {
                setRevokeTarget(null);
                setRevokeFeedback({kind: 'success', session: target});
            },
            onError: () => {
                setRevokeTarget(null);
                setRevokeFeedback({kind: 'error', session: target});
            },
            onSettled: () => releaseExclusiveAction(revokeInFlight.current),
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Smartphone className="size-5" />
                    연결된 모바일
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {!personalReady ? (
                    <EmptyState title="계정 연결이 필요합니다." />
                ) : sessions.isPending ? (
                    <LoadingState />
                ) : sessions.isError ? (
                    <ErrorState retry={() => void sessions.refetch()} />
                ) : activeSessions.length ? (
                    activeSessions.map((session) => (
                        <div
                            key={session.deviceId}
                            className="flex items-center justify-between gap-3 rounded-lg border p-3"
                        >
                            <div className="min-w-0">
                                <strong className="block truncate text-sm">
                                    {session.deviceLabel}
                                </strong>
                                <span className="text-xs text-muted-foreground">
                                    최근 사용 {dateTimeLabel(session.lastSeenAt)} ·{' '}
                                    {session.pushEnabled ? '푸시 켜짐' : '푸시 꺼짐'}
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${session.deviceLabel} 연결 해제`}
                                onClick={() => setRevokeTarget(session)}
                                disabled={revoke.isPending}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </div>
                    ))
                ) : (
                    <EmptyState title="연결된 모바일이 없습니다." />
                )}
                {revokeFeedback?.kind === 'success' ? (
                    <Alert aria-live="polite">
                        <Smartphone aria-hidden="true" />
                        <AlertTitle>연결 해제 완료</AlertTitle>
                        <AlertDescription>
                            {revokeFeedback.session.deviceLabel}의 개인 기능과 푸시를 해제했습니다.
                        </AlertDescription>
                    </Alert>
                ) : revokeFeedback?.kind === 'error' ? (
                    <Alert variant="destructive">
                        <CircleAlert aria-hidden="true" />
                        <AlertTitle>연결 해제 실패</AlertTitle>
                        <AlertDescription className="gap-3">
                            <p>
                                {revokeFeedback.session.deviceLabel} 연결은 유지됩니다. 네트워크를
                                확인하고 다시 시도하세요.
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setRevokeTarget(revokeFeedback.session)}
                                disabled={revoke.isPending}
                            >
                                다시 시도
                            </Button>
                        </AlertDescription>
                    </Alert>
                ) : null}
            </CardContent>
            <AlertDialog
                open={revokeTarget !== null}
                onOpenChange={(open) => {
                    if (!open && !revoke.isPending) setRevokeTarget(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {revokeTarget?.deviceLabel ?? '이 모바일'} 연결을 해제할까요?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            해제하면 이 기기의 출석과 개인 알림을 사용할 수 없습니다. 다시
                            사용하려면 새 코드로 연결해야 합니다.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={revoke.isPending}>유지</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={revoke.isPending}
                            onClick={(event) => {
                                event.preventDefault();
                                confirmRevoke();
                            }}
                        >
                            {revoke.isPending ? '해제 중' : '연결 해제'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    );
}

function DesktopConnections() {
    const {api} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const [pairing, setPairing] = useState<MobilePairingCreated | null>(null);
    const [pairingMessage, setPairingMessage] = useState('');
    const [identityMessage, setIdentityMessage] = useState('');
    const [identityResetReason, setIdentityResetReason] = useState<'reset' | null>(null);
    const refreshAccount = useRefreshAttendanceMutation();
    const personalReady =
        account.status.lmsAuthentication === 'authenticated' && serverSessionReady(account.status);

    const connection = useDesktopConnectionQuery();
    const connectionState = connection.data?.state;
    const refetchConnection = connection.refetch;
    const sessions = useQuery({
        queryKey: queryKeys.mobileSessions,
        queryFn: () => api.listMobileSessions(),
        enabled: personalReady,
        refetchInterval: 60_000,
    });
    const pairingStatus = useQuery({
        queryKey: ['pairing-status', pairing?.pairingId],
        queryFn: () => api.getMobilePairingStatus(pairing!.pairingId),
        enabled: pairing !== null && personalReady,
        refetchInterval: ({state}) => {
            const status = state.data?.status;
            return status === 'completed' || status === 'expired' ? false : 1_000;
        },
    });

    useEffect(() => {
        if (pairingStatus.data?.status === 'completed') {
            void client.invalidateQueries({queryKey: queryKeys.mobileSessions});
        }
    }, [client, pairingStatus.data?.status]);

    useEffect(() => {
        if (
            connectionState === 'disconnected' &&
            sessions.isSuccess &&
            sessions.dataUpdatedAt > 0
        ) {
            void refetchConnection();
        }
    }, [connectionState, refetchConnection, sessions.dataUpdatedAt, sessions.isSuccess]);

    const createPairing = useMutation({
        mutationFn: () => {
            assertLmsAuthenticated(account.status);
            assertServerSessionReady(account.status);
            if (
                connection.data?.state !== 'connected' &&
                connection.data?.state !== 'disconnected'
            ) {
                throw new Error('DESKTOP_CONNECTION_REQUIRED');
            }
            return api.createMobilePairing();
        },
        onSuccess: async (value) => {
            setPairing(value);
            setPairingMessage('');
            await client.invalidateQueries({queryKey: queryKeys.desktopConnection});
        },
    });
    const approve = useMutation({
        mutationFn: async () => {
            assertLmsAuthenticated(account.status);
            assertServerSessionReady(account.status);
            const claim = pairingStatus.data?.claim;
            if (!pairing || !claim) throw new Error('PAIRING_CLAIM_MISSING');
            await api.approveMobilePairing(pairing.pairingId, claim.claimId);
        },
        onSuccess: () => void pairingStatus.refetch(),
    });
    const revoke = useMutation({
        mutationFn: (id: string) => {
            assertLmsAuthenticated(account.status);
            assertServerSessionReady(account.status);
            return api.revokeMobileSession(id);
        },
        onSuccess: () => void client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
    });
    const reset = useMutation({
        mutationFn: async () => {
            if (connection.data?.state !== 'connected') {
                throw new Error('IDENTITY_RESET_NOT_AVAILABLE');
            }
            const value = await api.resetDesktopIdentity();
            if (value.state !== 'connected') throw new Error('IDENTITY_RESET_INCOMPLETE');
            return value;
        },
        onMutate: () => {
            setPairing(null);
            setIdentityMessage('');
            removeDesktopIdentityQueries(client);
        },
        onSuccess: async (value) => {
            client.setQueryData(queryKeys.desktopConnection, value);
            setIdentityResetReason(null);
            setIdentityMessage('PC 연결 정보를 초기화하고 새 서버 등록을 확인했습니다.');
            await client.invalidateQueries({queryKey: queryKeys.desktopConnection});
        },
    });

    const cancelDesktopPairing = () => {
        if (!pairing) return;
        client.removeQueries({queryKey: ['pairing-status', pairing.pairingId], exact: true});
        setPairing(null);
        setPairingMessage(
            '이 화면의 연결 대기를 중단했습니다. 발급한 코드는 서버 만료 전까지 유효할 수 있습니다. 새 코드를 만들면 이전 코드를 교체합니다.',
        );
    };

    const qr = useMemo(() => (pairing ? pairingQrDataUrl(pairing.qrPayload) : null), [pairing]);
    const connectionUi = desktopConnectionUiState(connection.data);
    const identityBusy = reset.isPending;
    const activeSessions = sessions.data?.filter((item) => item.status === 'active') ?? [];
    const serverSessionLabel =
        account.status.serverSession === 'stored'
            ? '보안 저장됨'
            : account.status.serverSession === 'memory-only'
              ? '현재 실행에서만 유지'
              : account.status.serverSession === 'recovery-required'
                ? '복구 필요'
                : account.status.serverSession === 'missing'
                  ? '없음'
                  : '확인 중';
    const lmsAuthenticationLabel =
        account.status.lmsAuthentication === 'authenticated'
            ? '로그인됨'
            : account.status.lmsAuthentication === 'required'
              ? '로그인 필요'
              : account.status.lmsAuthentication === 'unavailable'
                ? '확인 실패'
                : '확인 중';
    return (
        <div className="space-y-6">
            {connection.isPending ? (
                <LoadingState />
            ) : connection.isError ? (
                <ErrorState retry={() => void connection.refetch()} />
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle>이 PC</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2">
                        <div className="rounded-lg bg-muted/55 p-4 text-sm">
                            <strong>마지막 확인</strong>
                            <p className="mt-1 text-muted-foreground">
                                {relativeTimeLabel(connection.data?.lastSeenAt)}
                            </p>
                        </div>
                        <div className="rounded-lg bg-muted/55 p-4 text-sm">
                            <strong>서버 인증 정보</strong>
                            <p className="mt-1 text-muted-foreground">{serverSessionLabel}</p>
                        </div>
                        <div className="rounded-lg bg-muted/55 p-4 text-sm">
                            <strong>LMS 계정</strong>
                            <p className="mt-1 text-muted-foreground">{lmsAuthenticationLabel}</p>
                        </div>
                        {connection.data?.state === 'connected' ? (
                            <p className="text-sm text-muted-foreground sm:col-span-2">
                                연결 상태 · {connectionUi.label}
                            </p>
                        ) : null}
                        {connectionUi.needsIdentityRecovery ? (
                            <Alert className="sm:col-span-2" variant="destructive">
                                <CircleAlert />
                                <AlertTitle>{connectionUi.label}</AlertTitle>
                                <AlertDescription>
                                    <p>
                                        {connectionUi.reason}{' '}
                                        {
                                            '안전한 PC identity 복구는 현재 앱 계약에서 지원하지 않습니다. 초기화와 달리 기존 identity를 복원하는 별도 native/backend 계약이 필요합니다.'
                                        }
                                    </p>
                                    <Button className="mt-3" size="sm" variant="outline" disabled>
                                        <RotateCcw className="size-4" />
                                        복구 기능 준비 안 됨
                                    </Button>
                                </AlertDescription>
                            </Alert>
                        ) : connection.data?.state === 'disconnected' ? (
                            <Alert className="sm:col-span-2">
                                <CircleAlert />
                                <AlertTitle>{connectionUi.label}</AlertTitle>
                                <AlertDescription>
                                    <p>{connectionUi.reason}</p>
                                    <Button
                                        className="mt-3"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => refreshAccount.mutate()}
                                        disabled={
                                            refreshAccount.isPending ||
                                            account.status.lmsAuthentication !== 'authenticated'
                                        }
                                    >
                                        {refreshAccount.isPending ? '연결 중' : '계정 연결'}
                                    </Button>
                                </AlertDescription>
                            </Alert>
                        ) : null}
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
                <MobilePairingCard
                    approve={approve}
                    cancelPairing={cancelDesktopPairing}
                    connectionUi={connectionUi}
                    createPairing={createPairing}
                    pairing={pairing}
                    pairingMessage={pairingMessage}
                    pairingStatus={pairingStatus}
                    personalReady={personalReady}
                    qr={qr}
                    registersDesktop={connection.data?.state === 'disconnected'}
                />
                <ConnectedMobileCard
                    activeSessions={activeSessions}
                    personalReady={personalReady}
                    revoke={revoke}
                    sessions={sessions}
                />
            </div>

            {connection.data?.state === 'connected' ? (
                <Card className="border-destructive/25">
                    <CardHeader>
                        <CardTitle className="text-base">PC 연결 정보 초기화</CardTitle>
                        <CardDescription>
                            서버 연결을 새로 만들며 모든 모바일을 다시 연결해야 합니다.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Button
                            variant="destructive"
                            onClick={() => setIdentityResetReason('reset')}
                            disabled={identityBusy}
                        >
                            <RotateCcw className="size-4" />
                            초기화
                        </Button>
                        {reset.isError ? (
                            <p className="text-sm text-destructive">
                                PC 연결 정보를 초기화하지 못했습니다.
                            </p>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

            {identityMessage ? (
                <Alert aria-live="polite">
                    <RotateCcw aria-hidden="true" />
                    <AlertTitle>PC 연결 정보 처리 완료</AlertTitle>
                    <AlertDescription>{identityMessage}</AlertDescription>
                </Alert>
            ) : null}

            <AlertDialog
                open={identityResetReason !== null}
                onOpenChange={(open) => {
                    if (!open) setIdentityResetReason(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>PC 연결 정보를 초기화할까요?</AlertDialogTitle>
                        <AlertDialogDescription>
                            이 PC의 서버 계정과 인증 정보를 삭제하고 새로 만듭니다. 연결된 모바일은
                            모두 해제되며 되돌릴 수 없습니다.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={identityBusy}>아니요</AlertDialogCancel>
                        <AlertDialogAction disabled={identityBusy} onClick={() => reset.mutate()}>
                            네, PC 초기화
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

interface CompanionConnectionCardProps {
    checking: boolean;
    claimPending: boolean;
    confirmationCode: string;
    connected: boolean;
    disconnectFeedback: CompanionDisconnectFeedback;
    disconnectPending: boolean;
    manualCode: string;
    message: string;
    onCancelPairing: () => void;
    onChangeCode: () => void;
    onManualCodeChange: (value: string) => void;
    onRequestDisconnect: () => void;
    onStartManualPairing: () => void;
    pendingPairingExpiresAt: string | null;
}

function CompanionConnectionCard({
    checking,
    claimPending,
    confirmationCode,
    connected,
    disconnectFeedback,
    disconnectPending,
    manualCode,
    message,
    onCancelPairing,
    onChangeCode,
    onManualCodeChange,
    onRequestDisconnect,
    onStartManualPairing,
    pendingPairingExpiresAt,
}: CompanionConnectionCardProps) {
    return (
        <Card className="mx-auto max-w-xl">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <MonitorCheck className="size-5" />
                    {connected
                        ? '이 기기는 연결됨'
                        : claimPending
                          ? 'PC 승인 대기'
                          : '연결 코드 입력'}
                </CardTitle>
                <CardDescription>
                    {connected
                        ? 'PC 앱이 출석 상태를 주기적으로 갱신합니다.'
                        : '설치 QR 정보가 있으면 자동으로 연결하고, 없으면 PC 앱의 10자리 코드를 입력합니다.'}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {checking ? (
                    <LoadingState label="설치 QR 연결 정보를 확인하고 있습니다." />
                ) : connected ? (
                    <Button
                        variant="outline"
                        onClick={onRequestDisconnect}
                        disabled={disconnectPending}
                    >
                        이 모바일 연결 해제
                    </Button>
                ) : claimPending ? null : (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="pairing-code">10자리 연결 코드</Label>
                            <Input
                                id="pairing-code"
                                value={manualCode}
                                inputMode="text"
                                maxLength={11}
                                autoCapitalize="characters"
                                placeholder="ABCDE-12345"
                                onChange={(event) =>
                                    onManualCodeChange(formatManualPairingCode(event.target.value))
                                }
                            />
                        </div>
                        <Button
                            onClick={onStartManualPairing}
                            disabled={!validManualPairingCode(manualCode)}
                        >
                            연결 요청
                        </Button>
                    </>
                )}
                {claimPending ? (
                    <Alert>
                        <KeyRound />
                        <AlertTitle>PC에서 이 기기를 승인해 주세요.</AlertTitle>
                        <AlertDescription className="gap-3">
                            <p>
                                PC 화면의 확인 코드가 <strong>{confirmationCode}</strong>인지
                                확인하세요.
                            </p>
                            {pendingPairingExpiresAt ? (
                                <PairingExpiryCountdown expiresAt={pendingPairingExpiresAt} />
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                                {
                                    '이 시간은 기기에서 계산한 최대 10분입니다. 서버 만료 시 더 일찍 끝날 수 있습니다.'
                                }
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={onCancelPairing}
                                >
                                    연결 대기 취소
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={onChangeCode}
                                >
                                    코드 변경
                                </Button>
                            </div>
                        </AlertDescription>
                    </Alert>
                ) : null}
                {message ? (
                    <p aria-live="polite" className="text-sm text-muted-foreground">
                        {message}
                    </p>
                ) : null}
                <CompanionDisconnectFeedbackPanel
                    feedback={disconnectFeedback}
                    pending={disconnectPending}
                    onRetry={onRequestDisconnect}
                />
            </CardContent>
        </Card>
    );
}

function CompanionDisconnectDialog({
    open,
    pending,
    onOpenChange,
    onConfirm,
}: {
    open: boolean;
    pending: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>이 모바일 연결을 해제할까요?</AlertDialogTitle>
                    <AlertDialogDescription>
                        서버 푸시와 이 기기의 로컬 구독을 먼저 정리한 다음 연결 세션을 해제합니다.
                        이후 출석과 개인 알림을 사용할 수 없고, 다시 사용하려면 새 코드로 연결해야
                        합니다.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>유지</AlertDialogCancel>
                    <AlertDialogAction
                        disabled={pending}
                        onClick={(event) => {
                            event.preventDefault();
                            onConfirm();
                        }}
                    >
                        {pending ? '해제 중' : '연결 해제'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

export function CompanionConnections({
    completionPath = '/connections',
}: {
    completionPath?: CompanionCompletionPath;
}) {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const navigate = useNavigate();
    const [manualCode, setManualCode] = useState('');
    const [message, setMessage] = useState('');
    const [disconnectConfirmationOpen, setDisconnectConfirmationOpen] = useState(false);
    const [disconnectFeedback, setDisconnectFeedback] = useState<CompanionDisconnectFeedback>(null);
    const pairingStartGate = useRef({inFlight: false, automaticHandled: false});
    const pairingAbortController = useRef<AbortController | null>(null);
    const disconnectInFlight = useRef({inFlight: false});
    const completedPushCleanup = useRef<
        Extract<PushSubscriptionCleanupResult, {status: 'complete'}> | undefined
    >(undefined);
    const [automaticPairingHandled, setAutomaticPairingHandled] = useState(false);
    const [initialPairing] = useState(readInitialPairingEntry);
    const pairingLink = initialPairing?.kind === 'companion' ? initialPairing.link : null;
    const [restoredPairing, setRestoredPairing] = useState(() => {
        const storage = pairingPersistentStorage();
        return storage ? readPendingMobilePairing(storage, Date.now()) : null;
    });
    const [pendingPairingStartedAt, setPendingPairingStartedAt] = useState<number | null>(
        restoredPairing?.createdAtEpochMs ?? null,
    );
    const claim = useMutation({
        onMutate: () => setMessage(''),
        mutationFn: async ({mode, resumePairingId, signal}: PairingClaimStart) => {
            const installationId = mobileInstallationId();
            let request: PairingClaim | null = null;
            let pairingId: string;
            let createdAtEpochMs = Date.now();
            if (mode === 'resume') {
                if (!resumePairingId) throw new Error('PAIRING_ID_MISSING');
                pairingId = resumePairingId;
                createdAtEpochMs = restoredPairing?.createdAtEpochMs ?? createdAtEpochMs;
            } else if (mode === 'handoff') {
                request = await api.claimPairingHandoff({
                    deviceLabel: mobileDeviceLabel(),
                    installationId,
                });
                if (!request) return false;
                pairingId = request.claimId;
            } else if (mode === 'qr') {
                if (!pairingLink) throw new Error('PAIRING_LINK_MISSING');
                request = await api.claimQrPairing({
                    ...pairingLink,
                    deviceLabel: mobileDeviceLabel(),
                    installationId,
                });
                pairingId = pairingLink.pairingId;
            } else {
                request = await api.claimManualPairing({
                    manualCode,
                    deviceLabel: mobileDeviceLabel(),
                    installationId,
                });
                pairingId = request.claimId;
            }
            if (request) {
                const storage = pairingPersistentStorage();
                if (storage) {
                    storePendingMobilePairing(storage, {
                        pairingId,
                        claimId: request.claimId,
                        createdAtEpochMs,
                    });
                }
            }
            setPendingPairingStartedAt(createdAtEpochMs);
            await waitForPairingCompletion({
                pairingId,
                complete: (id) => api.completePairing(id),
                pause: (milliseconds) =>
                    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
                signal,
            });
            const storage = pairingPersistentStorage();
            if (storage) clearPendingMobilePairing(storage);
            return true;
        },
        onSuccess: async (completed) => {
            if (!completed) return;
            setMessage('연결이 완료됐습니다.');
            setPendingPairingStartedAt(null);
            setRestoredPairing(null);
            if (platform.accountAuthentication.kind === 'cookie') {
                await finishCompanionPairing({
                    completionPath,
                    navigate: (path) => navigate({to: path, replace: true}),
                    refreshSession: () => refreshBrowserPersonalQueries(client),
                });
            }
        },
        onError: (error) => {
            const storage = pairingPersistentStorage();
            if (storage) clearPendingMobilePairing(storage);
            setPendingPairingStartedAt(null);
            setRestoredPairing(null);
            setMessage(
                error.message === 'PAIRING_CANCELLED'
                    ? '연결 대기를 취소했습니다. 서버의 요청은 만료될 때까지 남을 수 있습니다.'
                    : /EXPIRED|NOT_FOUND|ALREADY_USED/u.test(error.message)
                      ? '연결 코드가 만료되었거나 교체됐습니다. PC에서 새 코드를 만든 뒤 다시 연결하세요.'
                      : '연결하지 못했습니다. 네트워크를 확인하거나 PC에서 새 코드를 만든 뒤 다시 시도하세요.',
            );
        },
    });
    const disconnect = useMutation({
        mutationFn: () =>
            disconnectCompanionWithPushCleanup({
                cleanupPush: () =>
                    cleanupPushSubscription({
                        storage: pushSubscriptionStorage(),
                        getLocalSubscription: () => platform.pwa.getPushSubscription(),
                        unregisterServer: (subscriptionId) =>
                            api.unregisterPushSubscription(subscriptionId),
                        unsubscribeLocal: (subscription) => {
                            if (
                                typeof subscription.endpoint !== 'string' ||
                                !subscription.endpoint
                            ) {
                                throw new Error('PUSH_SUBSCRIPTION_ENDPOINT_INVALID');
                            }
                            return platform.pwa.unsubscribePush(subscription.endpoint);
                        },
                    }),
                disconnectSession: () => api.disconnectMobileSession(),
                previousCleanup: completedPushCleanup.current,
            }),
        onMutate: () => client.cancelQueries({queryKey: queryKeys.accountSession, exact: true}),
        onSuccess: (result) => {
            setDisconnectConfirmationOpen(false);
            setDisconnectFeedback(result);
            setMessage('');
            if (result.pushCleanup.status === 'complete') {
                completedPushCleanup.current = result.pushCleanup;
            }
            if (result.session === 'disconnected') {
                removeBrowserPersonalQueries(client);
                setAutomaticPairingHandled(true);
            }
        },
    });
    const connected = account.personalAccess.status === 'connected';
    const confirmationCode = mobileInstallationId().slice(-4).toUpperCase();
    const startClaim = useCallback(
        (input: PairingClaimStart) => {
            if (!tryReservePairingStart(pairingStartGate.current)) return;
            const controller = new AbortController();
            pairingAbortController.current = controller;
            // Reservation is a pairing state-machine transition, not synchronization from props.
            // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
            setAutomaticPairingHandled(true);
            claim.mutate(
                {...input, signal: controller.signal},
                {
                    onSettled: () => {
                        if (pairingAbortController.current === controller) {
                            pairingAbortController.current = null;
                        }
                        releasePairingStart(pairingStartGate.current);
                    },
                },
            );
        },
        [claim],
    );

    const cancelPairingWait = () => {
        pairingAbortController.current?.abort();
        const storage = pairingPersistentStorage();
        if (storage) clearPendingMobilePairing(storage);
        setRestoredPairing(null);
        setPendingPairingStartedAt(null);
        setMessage('연결 대기를 취소하는 중입니다. 서버 요청은 만료 전까지 남을 수 있습니다.');
    };

    const confirmDisconnect = () => {
        if (!tryReserveExclusiveAction(disconnectInFlight.current)) return;
        setDisconnectFeedback(null);
        disconnect.mutate(undefined, {
            onSettled: () => releaseExclusiveAction(disconnectInFlight.current),
        });
    };

    useEffect(() => {
        const action = automaticPairingAction({
            account: account.personalAccess.status,
            alreadyHandled: automaticPairingHandled,
            hasRestoredPairing: restoredPairing !== null,
            hasQrLink: pairingLink !== null,
            canClaimHandoff: platform.pwa.installed,
        });
        if (action === 'clear') {
            pairingStartGate.current.automaticHandled = true;
            const storage = pairingPersistentStorage();
            if (storage) clearPendingMobilePairing(storage);
            return;
        }
        if (action === 'resume' && restoredPairing) {
            startClaim({mode: 'resume', resumePairingId: restoredPairing.pairingId});
            return;
        }
        if (action === 'qr') {
            startClaim({mode: 'qr'});
            return;
        }
        if (action === 'handoff') {
            startClaim({mode: 'handoff'});
        }
    }, [
        account.personalAccess.status,
        automaticPairingHandled,
        pairingLink,
        platform.pwa.installed,
        restoredPairing,
        startClaim,
    ]);

    const automaticCheckPending =
        account.personalAccess.status === 'unconnected' &&
        !automaticPairingHandled &&
        (restoredPairing !== null || pairingLink !== null || platform.pwa.installed);
    const checking = account.personalAccess.status === 'checking' || automaticCheckPending;
    const pendingPairingExpiresAt =
        pendingPairingStartedAt === null
            ? null
            : new Date(pendingPairingStartedAt + 10 * 60_000).toISOString();

    return (
        <div className="space-y-6">
            <CompanionConnectionCard
                checking={checking}
                claimPending={claim.isPending}
                confirmationCode={confirmationCode}
                connected={connected}
                disconnectFeedback={disconnectFeedback}
                disconnectPending={disconnect.isPending}
                manualCode={manualCode}
                message={message}
                onCancelPairing={cancelPairingWait}
                onChangeCode={() => {
                    setManualCode('');
                    cancelPairingWait();
                }}
                onManualCodeChange={setManualCode}
                onRequestDisconnect={() => setDisconnectConfirmationOpen(true)}
                onStartManualPairing={() => startClaim({mode: 'manual'})}
                pendingPairingExpiresAt={pendingPairingExpiresAt}
            />
            <CompanionDisconnectDialog
                open={disconnectConfirmationOpen}
                pending={disconnect.isPending}
                onOpenChange={(open) => {
                    if (!disconnect.isPending) setDisconnectConfirmationOpen(open);
                }}
                onConfirm={confirmDisconnect}
            />
        </div>
    );
}

function WebConnections() {
    return (
        <Card className="mx-auto max-w-xl">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Smartphone className="size-5" />앱 설치가 필요합니다.
                </CardTitle>
                <CardDescription>
                    기기 연결은 PC 앱 또는 홈 화면에 설치한 PWA에서만 제공됩니다.
                </CardDescription>
            </CardHeader>
        </Card>
    );
}

export interface ConnectionsPageProps {
    appStatus?: ReactNode;
    appStatusWarningCount?: number;
    tab?: ConnectionsTab;
    returnTo?: DashboardReturnTarget;
    onTabChange?: (tab: ConnectionsTab) => void;
}

export function ConnectionsPage({
    appStatus,
    appStatusWarningCount = 0,
    tab = 'status',
    returnTo,
    onTabChange,
}: ConnectionsPageProps = {}) {
    const {platform} = useDashboardEnvironment();
    const selectedTab = tab === 'status' && !appStatus ? 'notifications' : tab;
    const selectTab = (value: string) => {
        const nextTab = normalizeConnectionsSearch({tab: value}).tab;
        onTabChange?.(nextTab);
    };

    return (
        <div className="space-y-6">
            <PageHeader title="설정" />
            <Tabs value={selectedTab} onValueChange={selectTab} className="gap-5">
                <TabsList
                    aria-label="설정 구분"
                    className={`grid h-auto w-full sm:w-fit ${appStatus ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}
                >
                    {appStatus ? (
                        <TabsTrigger value="status">
                            앱 상태
                            {appStatusWarningCount > 0 ? (
                                <span
                                    aria-label={`확인이 필요한 앱 상태 ${appStatusWarningCount}개`}
                                    aria-live="polite"
                                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-white tabular-nums dark:bg-destructive/60"
                                >
                                    {appStatusWarningCount}
                                </span>
                            ) : null}
                        </TabsTrigger>
                    ) : null}
                    <TabsTrigger value="notifications">알림</TabsTrigger>
                    <TabsTrigger value="services">서비스</TabsTrigger>
                    <TabsTrigger value="devices">기기 연결</TabsTrigger>
                </TabsList>
                {appStatus ? <TabsContent value="status">{appStatus}</TabsContent> : null}
                <TabsContent value="notifications">
                    <PersonalAccountGate>
                        <NotificationSettings />
                    </PersonalAccountGate>
                </TabsContent>
                <TabsContent value="services">
                    <ServiceSettings />
                </TabsContent>
                <TabsContent value="devices">
                    {platform.capabilities.mobilePairingManagement ? (
                        <DesktopConnections />
                    ) : platform.accountAuthentication.kind === 'cookie' ? (
                        <CompanionConnections completionPath={returnTo ?? '/connections'} />
                    ) : (
                        <WebConnections />
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
