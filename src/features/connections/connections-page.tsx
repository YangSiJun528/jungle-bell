import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CircleAlert, KeyRound, Link2, MonitorCheck, QrCode, RotateCcw, Smartphone, Trash2} from 'lucide-react';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import type {MobilePairingCreated} from '@/api/dashboard-api';
import {
    formatManualPairingCode,
    validManualPairingCode,
} from '@/domain/connections/manual-pairing-code';
import {pairingQrDataUrl} from './lib/pairing-qr';
import {
    clearPendingMobilePairing,
    readPendingMobilePairing,
    storePendingMobilePairing,
} from './lib/pending-pairing';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';
import {
    mobileDeviceLabel,
    mobileInstallationId,
} from './mobile-identity';
import {readInitialPairingEntry} from '@/app/pairing-bootstrap';
import {desktopConnectionUiState} from './desktop-connection-state';
import {
    automaticPairingAction,
    releasePairingStart,
    tryReservePairingStart,
    waitForPairingCompletion,
} from './pairing-flow';

interface PairingClaimStart {
    mode: 'manual' | 'qr' | 'resume';
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
    const client = useQueryClient();
    const [pairing, setPairing] = useState<MobilePairingCreated | null>(null);

    const connection = useQuery({
        queryKey: queryKeys.desktopConnection,
        queryFn: () => api.getDesktopConnectionState(),
        refetchInterval: 60_000,
    });
    const sessions = useQuery({
        queryKey: queryKeys.mobileSessions,
        queryFn: () => api.listMobileSessions(),
        refetchInterval: 60_000,
    });
    const settings = useQuery({
        queryKey: queryKeys.desktopSettings,
        queryFn: () => api.getDesktopSettings(),
    });
    const pairingStatus = useQuery({
        queryKey: ['pairing-status', pairing?.pairingId],
        queryFn: () => api.getMobilePairingStatus(pairing!.pairingId),
        enabled: pairing !== null,
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
        if (connection.data?.state === 'disconnected' && sessions.isSuccess) {
            void connection.refetch();
        }
    }, [connection.data?.state, connection.refetch, sessions.dataUpdatedAt, sessions.isSuccess]);

    const createPairing = useMutation({
        mutationFn: () => {
            if (connection.data?.state !== 'connected'
                && connection.data?.state !== 'disconnected') {
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
            const claim = pairingStatus.data?.claim;
            if (!pairing || !claim) throw new Error('PAIRING_CLAIM_MISSING');
            await api.approveMobilePairing(pairing.pairingId, claim.claimId);
        },
        onSuccess: () => void pairingStatus.refetch(),
    });
    const revoke = useMutation({
        mutationFn: (id: string) => api.revokeMobileSession(id),
        onSuccess: () => void client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
    });
    const updateSettings = useMutation({
        mutationFn: (autoStart: boolean) => api.updateDesktopSettings({autoStart}),
        onSuccess: (value) => client.setQueryData(queryKeys.desktopSettings, value),
    });
    const reset = useMutation({
        mutationFn: () => api.resetDesktopIdentity(),
        onSuccess: async (value) => {
            setPairing(null);
            client.setQueryData(queryKeys.desktopConnection, value);
            await Promise.all([
                client.invalidateQueries({queryKey: queryKeys.desktopConnection}),
                client.invalidateQueries({queryKey: queryKeys.mobileSessions}),
            ]);
        },
    });

    const qr = useMemo(() => pairing ? pairingQrDataUrl(pairing.qrPayload) : null, [pairing]);
    const connectionUi = desktopConnectionUiState(connection.data);
    const activeSessions = sessions.data?.filter((item) => item.status === 'active') ?? [];
    return (
        <div className="space-y-6">
            <PageHeader title="설정"/>
            {connection.isPending ? <LoadingState/> : connection.isError ? <ErrorState retry={() => void connection.refetch()}/> : (
                <Card>
                    <CardHeader>
                        <CardTitle>이 PC</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2">
                        <div className="rounded-lg bg-muted/55 p-4 text-sm"><strong>마지막 확인</strong><p className="mt-1 text-muted-foreground">{relativeTimeLabel(connection.data?.lastSeenAt)}</p></div>
                        <label className="flex items-center justify-between rounded-lg border p-4 text-sm">
                            <span><strong>로그인 시 자동 시작</strong><span className="mt-1 block text-xs text-muted-foreground">백그라운드 상태 갱신을 유지합니다.</span></span>
                            <Switch checked={settings.data?.autoStart ?? false} disabled={!settings.data || updateSettings.isPending} onCheckedChange={(checked) => updateSettings.mutate(checked)}/>
                        </label>
                        {connection.data?.state === 'connected' ? (
                            <p className="text-sm text-muted-foreground sm:col-span-2">연결 상태 · {connectionUi.label}</p>
                        ) : null}
                        {(settings.isError || updateSettings.isError) ? (
                            <p className="text-sm text-destructive sm:col-span-2">자동 시작 설정을 불러오거나 저장하지 못했습니다.</p>
                        ) : null}
                        {connectionUi.needsIdentityRecovery ? (
                            <Alert className="sm:col-span-2" variant="destructive">
                                <CircleAlert/>
                                <AlertTitle>{connectionUi.label}</AlertTitle>
                                <AlertDescription>
                                    <p>{connectionUi.reason} 복구하면 연결된 모바일을 다시 연결해야 합니다.</p>
                                    <Button
                                        className="mt-3"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            if (window.confirm('PC 연결 정보를 복구할까요? 모든 모바일을 다시 연결해야 합니다.')) reset.mutate();
                                        }}
                                        disabled={reset.isPending}
                                    >
                                        <RotateCcw className="size-4"/>{reset.isPending ? '복구 중' : 'PC 연결 정보 복구'}
                                    </Button>
                                    {reset.isError ? <p className="mt-2 text-sm text-destructive">PC 연결 정보를 복구하지 못했습니다.</p> : null}
                                </AlertDescription>
                            </Alert>
                        ) : connection.data?.state === 'disconnected' ? (
                            <Alert className="sm:col-span-2">
                                <CircleAlert/>
                                <AlertTitle>{connectionUi.label}</AlertTitle>
                                <AlertDescription>
                                    <p>{connectionUi.reason}</p>
                                    <Button className="mt-3" size="sm" variant="outline" onClick={() => void connection.refetch()} disabled={connection.isFetching}>
                                        {connection.isFetching ? '확인 중' : '연결 상태 다시 확인'}
                                    </Button>
                                </AlertDescription>
                            </Alert>
                        ) : null}
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2"><QrCode className="size-5"/>모바일 연결</CardTitle><CardDescription>설치한 PWA에서 QR 또는 10자리 코드를 입력하세요. 코드는 2분 동안 유효합니다.</CardDescription></CardHeader>
                    <CardContent className="space-y-4">
                        {!connectionUi.canCreatePairing ? (
                            <p className="text-sm text-muted-foreground">PC 연결 상태를 확인한 뒤 코드를 만들 수 있습니다.</p>
                        ) : !pairing ? (
                            <div className="space-y-3">
                                <Button onClick={() => createPairing.mutate()} disabled={createPairing.isPending || !connectionUi.canCreatePairing}><Link2 className="size-4"/>{connection.data?.state === 'disconnected' ? 'PC 등록 및 연결 코드 만들기' : '연결 코드 만들기'}</Button>
                                {createPairing.isError ? <p className="text-sm text-destructive">연결 코드를 만들지 못했습니다. 잠시 후 다시 시도하세요.</p> : null}
                            </div>
                        ) : (
                            <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
                                {qr ? <img src={qr} alt="모바일 연결 QR 코드" className="aspect-square w-36 rounded-lg border bg-white p-2"/> : null}
                                <div className="space-y-3">
                                    <div><p className="text-xs text-muted-foreground">수동 연결 코드</p><p className="mt-1 font-mono text-2xl font-bold tracking-wider">{formatManualPairingCode(pairing.manualCode)}</p></div>
                                    {pairingStatus.data?.status === 'completed' ? (
                                        <p aria-live="polite" className="text-sm text-emerald-700 dark:text-emerald-300">연결이 완료됐습니다.</p>
                                    ) : pairingStatus.data?.status === 'expired' ? (
                                        <p aria-live="polite" className="text-sm text-destructive">연결 코드가 만료됐습니다.</p>
                                    ) : null}
                                    {pairingStatus.data?.claim ? (
                                        <Alert><KeyRound/><AlertTitle>{pairingStatus.data.claim.deviceLabel}</AlertTitle><AlertDescription>확인 코드 {pairingStatus.data.claim.confirmationCode}</AlertDescription><Button className="mt-3" size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>이 기기 승인</Button></Alert>
                                    ) : null}
                                    {pairingStatus.isError ? (
                                        <div className="space-y-2 text-sm text-destructive">
                                            <p>연결 상태를 확인하지 못했습니다.</p>
                                            <Button variant="outline" size="sm" onClick={() => void pairingStatus.refetch()}>다시 확인</Button>
                                        </div>
                                    ) : null}
                                    {approve.isError ? <p className="text-sm text-destructive">이 기기를 승인하지 못했습니다.</p> : null}
                                    <Button variant="outline" size="sm" onClick={() => createPairing.mutate()}>새 코드</Button>
                                    {createPairing.isError ? <p className="text-sm text-destructive">새 연결 코드를 만들지 못했습니다.</p> : null}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2"><Smartphone className="size-5"/>연결된 모바일</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                        {sessions.isPending ? <LoadingState/> : sessions.isError ? <ErrorState retry={() => void sessions.refetch()}/> : activeSessions.length ? activeSessions.map((session) => (
                            <div key={session.deviceId} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                                <div className="min-w-0"><strong className="block truncate text-sm">{session.deviceLabel}</strong><span className="text-xs text-muted-foreground">최근 사용 {dateTimeLabel(session.lastSeenAt)} · {session.pushEnabled ? '푸시 켜짐' : '푸시 꺼짐'}</span></div>
                                <Button variant="ghost" size="icon-sm" aria-label={`${session.deviceLabel} 연결 해제`} onClick={() => revoke.mutate(session.deviceId)}><Trash2 className="size-4"/></Button>
                            </div>
                        )) : <EmptyState title="연결된 모바일이 없습니다."/>}
                        {revoke.isError ? <p className="text-sm text-destructive">모바일 연결을 해제하지 못했습니다.</p> : null}
                    </CardContent>
                </Card>
            </div>

            {connection.data?.state === 'connected' ? <Card className="border-destructive/25">
                <CardHeader><CardTitle className="text-base">PC 연결 정보 초기화</CardTitle><CardDescription>서버 연결을 새로 만들며 모든 모바일을 다시 연결해야 합니다.</CardDescription></CardHeader>
                <CardContent className="space-y-3"><Button variant="destructive" onClick={() => { if (window.confirm('PC 연결 정보를 초기화할까요?')) reset.mutate(); }} disabled={reset.isPending}><RotateCcw className="size-4"/>초기화</Button>{reset.isError ? <p className="text-sm text-destructive">PC 연결 정보를 초기화하지 못했습니다.</p> : null}</CardContent>
            </Card> : null}
        </div>
    );
}

function CompanionConnections() {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const [manualCode, setManualCode] = useState('');
    const [message, setMessage] = useState('');
    const pairingStartGate = useRef({inFlight: false, automaticHandled: false});
    const initialPairing = useMemo(readInitialPairingEntry, []);
    const pairingLink = initialPairing?.kind === 'companion' ? initialPairing.link : null;
    const [restoredPairing, setRestoredPairing] = useState(() => {
        const storage = pairingSessionStorage();
        return storage ? readPendingMobilePairing(storage, Date.now()) : null;
    });
    const attendance = useQuery({queryKey: queryKeys.attendance('companion'), queryFn: () => api.getAttendance('companion')});

    const claim = useMutation({
        mutationFn: async ({mode, resumePairingId}: PairingClaimStart) => {
            const installationId = mobileInstallationId();
            const request = mode === 'resume'
                ? null
                : mode === 'qr' && pairingLink
                ? await api.claimQrPairing({
                    ...pairingLink,
                    deviceLabel: mobileDeviceLabel(),
                    installationId,
                })
                : await api.claimManualPairing({
                    manualCode,
                    deviceLabel: mobileDeviceLabel(),
                    installationId,
                });
            const pairingId = mode === 'resume'
                ? resumePairingId!
                : mode === 'qr' && pairingLink
                    ? pairingLink.pairingId
                    : request!.claimId;
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
                pause: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
            });
            const storage = pairingSessionStorage();
            if (storage) clearPendingMobilePairing(storage);
        },
        onSuccess: async () => {
            setMessage('연결이 완료됐습니다.');
            window.location.hash = '#connections';
            await client.invalidateQueries();
        },
        onError: () => {
            const storage = pairingSessionStorage();
            if (storage) clearPendingMobilePairing(storage);
            setMessage('연결하지 못했습니다. PC에서 새 코드를 만든 뒤 다시 시도하세요.');
        },
    });
    const disconnect = useMutation({
        mutationFn: () => api.disconnectMobileSession(),
        onSuccess: () => void client.invalidateQueries(),
    });
    const connected = attendance.data?.state === 'loaded';
    const confirmationCode = mobileInstallationId().slice(-4).toUpperCase();
    const startClaim = useCallback((input: PairingClaimStart) => {
        if (!tryReservePairingStart(pairingStartGate.current)) return;
        claim.mutate(input, {
            onSettled: () => releasePairingStart(pairingStartGate.current),
        });
    }, [claim]);

    useEffect(() => {
        const attendanceState = attendance.isPending
            ? 'pending'
            : attendance.isError
                ? 'error'
                : attendance.data?.state ?? 'pending';
        const action = automaticPairingAction({
            attendance: attendanceState,
            alreadyHandled: pairingStartGate.current.automaticHandled,
            hasRestoredPairing: restoredPairing !== null,
            hasQrLink: pairingLink !== null,
        });
        if (action === 'clear') {
            pairingStartGate.current.automaticHandled = true;
            const storage = pairingSessionStorage();
            if (storage) clearPendingMobilePairing(storage);
            setRestoredPairing(null);
            return;
        }
        if (action === 'resume' && restoredPairing) {
            startClaim({mode: 'resume', resumePairingId: restoredPairing.pairingId});
            return;
        }
        if (action === 'qr') {
            startClaim({mode: 'qr'});
        }
    }, [attendance.data?.state, attendance.isError, attendance.isPending, pairingLink, restoredPairing, startClaim]);

    return (
        <div className="space-y-6">
            <PageHeader title="설정"/>
            <Card className="mx-auto max-w-xl">
                <CardHeader><CardTitle className="flex items-center gap-2"><MonitorCheck className="size-5"/>{connected ? '이 기기는 연결됨' : '연결 코드 입력'}</CardTitle><CardDescription>{connected ? 'PC 앱이 출석 상태를 주기적으로 갱신합니다.' : 'PC 앱의 기기 연결 화면에 표시된 코드를 입력하세요.'}</CardDescription></CardHeader>
                <CardContent className="space-y-4">
                    {connected ? (
                        <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>이 모바일 연결 해제</Button>
                    ) : (
                        <>
                            <div className="space-y-2"><Label htmlFor="pairing-code">10자리 연결 코드</Label><Input id="pairing-code" value={manualCode} inputMode="text" maxLength={11} autoCapitalize="characters" placeholder="ABCDE-12345" onChange={(event) => setManualCode(formatManualPairingCode(event.target.value))}/></div>
                            <Button onClick={() => startClaim({mode: 'manual'})} disabled={!validManualPairingCode(manualCode) || claim.isPending}>연결 요청</Button>
                        </>
                    )}
                    {claim.isPending ? (
                        <Alert>
                            <KeyRound/>
                            <AlertTitle>PC에서 이 기기를 승인해 주세요.</AlertTitle>
                            <AlertDescription>PC 화면의 확인 코드가 <strong>{confirmationCode}</strong>인지 확인하세요.</AlertDescription>
                        </Alert>
                    ) : null}
                    {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
                </CardContent>
            </Card>
        </div>
    );
}

export function ConnectionsPage() {
    const {surface} = useDashboardEnvironment();
    return surface.kind === 'desktop' ? <DesktopConnections/> : <CompanionConnections/>;
}
