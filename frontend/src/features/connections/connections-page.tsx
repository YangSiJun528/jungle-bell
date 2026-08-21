import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
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
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {MobilePairingCreated, PairingClaim} from '@/api/dashboard-api';
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

import {desktopConnectionUiState} from './desktop-connection-state';
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
}

function pairingSessionStorage(): Storage | null {
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

function DesktopConnections() {
    const {api} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const [pairing, setPairing] = useState<MobilePairingCreated | null>(null);
    const [identityResetReason, setIdentityResetReason] = useState<'recovery' | 'reset' | null>(
        null,
    );
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
        mutationFn: () => api.resetDesktopIdentity(),
        onMutate: () => {
            setPairing(null);
            removeDesktopIdentityQueries(client);
        },
        onSuccess: async (value) => {
            client.setQueryData(queryKeys.desktopConnection, value);
            await client.invalidateQueries({queryKey: queryKeys.desktopConnection});
        },
    });

    const qr = useMemo(() => (pairing ? pairingQrDataUrl(pairing.qrPayload) : null), [pairing]);
    const connectionUi = desktopConnectionUiState(connection.data);
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
                                        {connectionUi.reason} 복구하면 연결된 모바일을 다시 연결해야
                                        합니다.
                                    </p>
                                    <Button
                                        className="mt-3"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setIdentityResetReason('recovery')}
                                        disabled={reset.isPending}
                                    >
                                        <RotateCcw className="size-4" />
                                        {reset.isPending ? '복구 중' : 'PC 연결 정보 복구'}
                                    </Button>
                                    {reset.isError ? (
                                        <p className="mt-2 text-sm text-destructive">
                                            PC 연결 정보를 복구하지 못했습니다.
                                        </p>
                                    ) : null}
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
                                    disabled={
                                        createPairing.isPending || !connectionUi.canCreatePairing
                                    }
                                >
                                    <Link2 className="size-4" />
                                    {connection.data?.state === 'disconnected'
                                        ? 'PC 등록 및 휴대폰 설정 시작'
                                        : '휴대폰 설정 QR 만들기'}
                                </Button>
                                {createPairing.isError ? (
                                    <p className="text-sm text-destructive">
                                        연결 코드를 만들지 못했습니다. 잠시 후 다시 시도하세요.
                                    </p>
                                ) : null}
                            </div>
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
                                    ) : pairingStatus.data?.status === 'expired' ? (
                                        <p aria-live="polite" className="text-sm text-destructive">
                                            연결 코드가 만료됐습니다.
                                        </p>
                                    ) : null}
                                    {pairingStatus.data?.claim ? (
                                        <Alert>
                                            <KeyRound />
                                            <AlertTitle>
                                                {pairingStatus.data.claim.deviceLabel}
                                            </AlertTitle>
                                            <AlertDescription>
                                                <span>
                                                    확인 번호{' '}
                                                    {pairingStatus.data.claim.confirmationCode}
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
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => createPairing.mutate()}
                                    >
                                        새 QR과 코드
                                    </Button>
                                    {createPairing.isError ? (
                                        <p className="text-sm text-destructive">
                                            새 연결 코드를 만들지 못했습니다.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

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
                                        onClick={() => revoke.mutate(session.deviceId)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            ))
                        ) : (
                            <EmptyState title="연결된 모바일이 없습니다." />
                        )}
                        {revoke.isError ? (
                            <p className="text-sm text-destructive">
                                모바일 연결을 해제하지 못했습니다.
                            </p>
                        ) : null}
                    </CardContent>
                </Card>
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
                            disabled={reset.isPending}
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

            <AlertDialog
                open={identityResetReason !== null}
                onOpenChange={(open) => {
                    if (!open) setIdentityResetReason(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {identityResetReason === 'recovery'
                                ? 'PC 연결 정보를 복구할까요?'
                                : 'PC 연결 정보를 초기화할까요?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {identityResetReason === 'recovery'
                                ? '남아 있는 로컬 인증 정보를 새로 만듭니다. 이전 서버 credential이 이미 없으면 기존 모바일 정리는 운영자 확인이 필요할 수 있습니다.'
                                : '이 PC의 서버 계정과 인증 정보를 삭제하고 새로 만듭니다. 연결된 모바일은 모두 해제되며 되돌릴 수 없습니다.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>아니요</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={reset.isPending}
                            onClick={() => reset.mutate()}
                        >
                            네, PC 초기화
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
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
    const pairingStartGate = useRef({inFlight: false, automaticHandled: false});
    const [automaticPairingHandled, setAutomaticPairingHandled] = useState(false);
    const [initialPairing] = useState(readInitialPairingEntry);
    const pairingLink = initialPairing?.kind === 'companion' ? initialPairing.link : null;
    const [restoredPairing] = useState(() => {
        const storage = pairingSessionStorage();
        return storage ? readPendingMobilePairing(storage, Date.now()) : null;
    });
    const claim = useMutation({
        mutationFn: async ({mode, resumePairingId}: PairingClaimStart) => {
            const installationId = mobileInstallationId();
            let request: PairingClaim | null = null;
            let pairingId: string;
            if (mode === 'resume') {
                if (!resumePairingId) throw new Error('PAIRING_ID_MISSING');
                pairingId = resumePairingId;
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
                const storage = pairingSessionStorage();
                if (storage) {
                    storePendingMobilePairing(storage, {
                        pairingId,
                        claimId: request.claimId,
                        createdAtEpochMs: Date.now(),
                    });
                }
            }
            await waitForPairingCompletion({
                pairingId,
                complete: (id) => api.completePairing(id),
                pause: (milliseconds) =>
                    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
            });
            const storage = pairingSessionStorage();
            if (storage) clearPendingMobilePairing(storage);
            return true;
        },
        onSuccess: async (completed) => {
            if (!completed) return;
            setMessage('연결이 완료됐습니다.');
            if (platform.accountAuthentication.kind === 'cookie') {
                await finishCompanionPairing({
                    completionPath,
                    navigate: (path) => navigate({to: path, replace: true}),
                    refreshSession: () => refreshBrowserPersonalQueries(client),
                });
            }
        },
        onError: () => {
            const storage = pairingSessionStorage();
            if (storage) clearPendingMobilePairing(storage);
            setMessage('연결하지 못했습니다. PC에서 새 코드를 만든 뒤 다시 시도하세요.');
        },
    });
    const disconnect = useMutation({
        mutationFn: () => api.disconnectMobileSession(),
        onMutate: () => client.cancelQueries({queryKey: queryKeys.accountSession, exact: true}),
        onSuccess: () => {
            removeBrowserPersonalQueries(client);
            setAutomaticPairingHandled(true);
            setMessage('이 모바일 연결을 해제했습니다.');
        },
    });
    const connected = account.personalAccess.status === 'connected';
    const confirmationCode = mobileInstallationId().slice(-4).toUpperCase();
    const startClaim = useCallback(
        (input: PairingClaimStart) => {
            if (!tryReservePairingStart(pairingStartGate.current)) return;
            // Reservation is a pairing state-machine transition, not synchronization from props.
            // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
            setAutomaticPairingHandled(true);
            claim.mutate(input, {
                onSettled: () => releasePairingStart(pairingStartGate.current),
            });
        },
        [claim],
    );

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
            const storage = pairingSessionStorage();
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

    return (
        <div className="space-y-6">
            <Card className="mx-auto max-w-xl">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <MonitorCheck className="size-5" />
                        {connected
                            ? '이 기기는 연결됨'
                            : claim.isPending
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
                            onClick={() => disconnect.mutate()}
                            disabled={disconnect.isPending}
                        >
                            이 모바일 연결 해제
                        </Button>
                    ) : (
                        <>
                            {!claim.isPending ? (
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
                                                setManualCode(
                                                    formatManualPairingCode(event.target.value),
                                                )
                                            }
                                        />
                                    </div>
                                    <Button
                                        onClick={() => startClaim({mode: 'manual'})}
                                        disabled={!validManualPairingCode(manualCode)}
                                    >
                                        연결 요청
                                    </Button>
                                </>
                            ) : null}
                        </>
                    )}
                    {claim.isPending ? (
                        <Alert>
                            <KeyRound />
                            <AlertTitle>PC에서 이 기기를 승인해 주세요.</AlertTitle>
                            <AlertDescription>
                                PC 화면의 확인 코드가 <strong>{confirmationCode}</strong>인지
                                확인하세요.
                            </AlertDescription>
                        </Alert>
                    ) : null}
                    {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
                </CardContent>
            </Card>
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

export function ConnectionsPage() {
    const {platform} = useDashboardEnvironment();

    return (
        <div className="space-y-6">
            <PageHeader title="설정" />
            <Tabs defaultValue="notifications" className="gap-5">
                <TabsList
                    aria-label="설정 구분"
                    className="grid h-auto w-full grid-cols-3 sm:w-fit"
                >
                    <TabsTrigger value="notifications">알림</TabsTrigger>
                    <TabsTrigger value="services">서비스</TabsTrigger>
                    <TabsTrigger value="devices">기기 연결</TabsTrigger>
                </TabsList>
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
                        <CompanionConnections />
                    ) : (
                        <WebConnections />
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
