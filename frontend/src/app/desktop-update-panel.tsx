import {Download, ExternalLink, RefreshCw, ScrollText} from 'lucide-react';

import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import type {DesktopUpdateStatus} from '@/platform/contracts';

const RELEASE_URL = 'https://github.com/YangSiJun528/jungle-bell/releases/latest';

interface DesktopUpdatePanelProps {
    status: DesktopUpdateStatus | undefined;
    checkFailed?: boolean;
    installFailed?: boolean;
    installPending: boolean;
    logFailed: boolean;
    compact?: boolean;
    onInstall: () => void;
    onCheckAgain: () => void;
    onOpenLogs: () => void;
    onLater?: () => void;
}

function failureSummary(errorCode: string | null | undefined): string {
    switch (errorCode) {
        case 'UPDATER_UNAVAILABLE':
            return '업데이트 서비스를 시작하지 못했습니다.';
        case 'UPDATE_CHECK_FAILED':
            return '최신 버전 확인 단계에서 실패했습니다.';
        case 'UPDATE_DOWNLOAD_FAILED':
            return '다운로드 단계에서 실패했습니다.';
        case 'UPDATE_VERIFY_FAILED':
            return '서명 검증 단계에서 실패해 설치를 중단했습니다.';
        case 'UPDATE_INSTALL_FAILED':
            return '설치 단계에서 실패했습니다.';
        case 'UPDATE_INSTALL_IN_PROGRESS':
            return '다른 업데이트 작업이 이미 진행 중입니다.';
        case 'UPDATE_STATE_SAVE_FAILED':
            return '업데이트 재시도 상태를 저장하지 못했습니다.';
        default:
            return '업데이트 작업을 완료하지 못했습니다.';
    }
}

function stageTitle(status: DesktopUpdateStatus | undefined, checkFailed: boolean): string {
    if (!status) return checkFailed ? '업데이트를 확인하지 못했습니다' : '업데이트 확인 중';
    const updateStatus = status.status;
    switch (updateStatus) {
        case 'checking':
            return '업데이트 확인 중';
        case 'latest':
            return '최신 버전입니다';
        case 'optional':
            return 'Jungle Bell 업데이트가 있습니다';
        case 'mandatory':
            return 'PC 앱 업데이트가 필요합니다';
        case 'downloading':
            return '업데이트 다운로드 중';
        case 'verifying':
            return '업데이트 검증 중';
        case 'installing':
            return '업데이트 설치 중';
        case 'restart-required':
            return '재시작 준비 완료';
        case 'failed':
            return '업데이트를 완료하지 못했습니다';
        default: {
            const exhaustive: never = updateStatus;
            return exhaustive;
        }
    }
}

function UpdateProgress({status}: {status: DesktopUpdateStatus | undefined}) {
    const active =
        !status ||
        ['checking', 'downloading', 'verifying', 'installing', 'restart-required'].includes(
            status.status,
        );
    if (!active) return null;
    const progress = status?.progress;
    const totalBytes = progress?.totalBytes;
    const downloadedBytes = progress?.downloadedBytes ?? 0;
    const determinate = typeof totalBytes === 'number';
    const complete = status?.status === 'restart-required';
    const value = complete ? 1 : determinate ? downloadedBytes : undefined;
    const max = complete ? 1 : determinate ? totalBytes : undefined;
    const percent =
        determinate && totalBytes > 0
            ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
            : null;
    return (
        <output className="mt-3 block w-full space-y-1" aria-live="polite">
            <progress
                className="h-2 w-full accent-primary"
                aria-label={stageTitle(status, false)}
                value={value}
                max={max}
            />
            {percent !== null && status?.status === 'downloading' ? (
                <p>{percent}% 다운로드됨</p>
            ) : null}
        </output>
    );
}

export function DesktopUpdatePanel({
    status,
    checkFailed = false,
    installFailed = false,
    installPending,
    logFailed,
    compact = false,
    onInstall,
    onCheckAgain,
    onOpenLogs,
    onLater,
}: DesktopUpdatePanelProps) {
    const failed = checkFailed || installFailed || status?.status === 'failed';
    const hasRelease = status?.availableVersion !== null && status?.availableVersion !== undefined;
    const ready = status?.status === 'optional' || status?.status === 'mandatory';
    const retryInstall = failed && hasRelease;

    return (
        <Alert
            role={failed ? 'alert' : 'status'}
            aria-live={failed ? 'assertive' : 'polite'}
            className={compact ? 'mb-4 border-amber-500/50 bg-amber-500/10' : undefined}
        >
            <Download aria-hidden="true" />
            <AlertTitle>{stageTitle(status, checkFailed)}</AlertTitle>
            <AlertDescription className="mt-1 w-full gap-3">
                {hasRelease ? (
                    <p>
                        현재 v{status.currentVersion} ·{' '}
                        {status.policy === 'mandatory' ? '최신 정식 버전' : '최신'} v
                        {status.availableVersion}
                    </p>
                ) : (
                    <p>안전한 실행을 위해 PC 앱의 최신 호환 버전을 확인하고 있습니다.</p>
                )}
                {failed ? (
                    <div className="space-y-1">
                        <p className="font-medium text-destructive">
                            {failureSummary(
                                checkFailed ? 'UPDATE_CHECK_FAILED' : status?.errorCode,
                            )}
                        </p>
                        <p>인터넷 연결을 확인한 뒤 다시 시도하세요.</p>
                    </div>
                ) : null}
                {failed ? null : <UpdateProgress status={status} />}
                <div className="flex flex-wrap gap-2 pt-1">
                    {ready || retryInstall ? (
                        <Button disabled={installPending} onClick={onInstall}>
                            {retryInstall ? (
                                <RefreshCw aria-hidden="true" />
                            ) : (
                                <Download aria-hidden="true" />
                            )}
                            {retryInstall ? '업데이트 다시 시도' : '업데이트하고 재시작'}
                        </Button>
                    ) : null}
                    {failed && !hasRelease ? (
                        <Button disabled={installPending} onClick={onCheckAgain}>
                            <RefreshCw aria-hidden="true" />
                            다시 확인
                        </Button>
                    ) : null}
                    {onLater && status?.status === 'optional' ? (
                        <Button variant="outline" onClick={onLater}>
                            나중에
                        </Button>
                    ) : null}
                    {failed ? (
                        <>
                            <Button variant="outline" onClick={onOpenLogs}>
                                <ScrollText aria-hidden="true" />
                                로그 폴더 열기
                            </Button>
                            <Button variant="outline" asChild>
                                <a href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink aria-hidden="true" />
                                    릴리스에서 수동 설치
                                </a>
                            </Button>
                        </>
                    ) : null}
                </div>
                {logFailed ? (
                    <p className="text-destructive">로그 폴더를 열지 못했습니다.</p>
                ) : null}
            </AlertDescription>
        </Alert>
    );
}
