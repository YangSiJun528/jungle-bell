import {RefreshCw} from 'lucide-react';
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
    type PropsWithChildren,
} from 'react';

import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {preparePwaReload} from '@/platform/pwa/reload-preservation';
import type {PwaUpdateBootstrap} from '@/platform/pwa/update-bootstrap';
import type {PwaUpdateSnapshot} from '@/platform/pwa/update-lifecycle';

const IDLE_SNAPSHOT: PwaUpdateSnapshot = Object.freeze({status: 'idle', error: null});

interface PwaUpdatePresentation {
    description: string;
    failed: boolean;
    title: string;
}

function updatePresentation(
    snapshot: PwaUpdateSnapshot,
    actionError: boolean,
): PwaUpdatePresentation | null {
    if (actionError && snapshot.status === 'ready') {
        return {
            title: '입력을 보존하지 못했습니다.',
            description: '현재 화면은 그대로 유지됩니다. 입력을 확인한 뒤 다시 시도하세요.',
            failed: true,
        };
    }
    switch (snapshot.status) {
        case 'idle':
            return null;
        case 'installing':
            return {
                title: '새 버전을 준비하고 있습니다.',
                description: '현재 페이지를 자동으로 다시 열지 않습니다.',
                failed: false,
            };
        case 'ready':
            return {
                title: '새 버전을 사용할 수 있습니다.',
                description: '업데이트 적용을 선택해야만 입력을 보존한 뒤 페이지를 다시 엽니다.',
                failed: false,
            };
        case 'activating':
            return {
                title: '입력을 보존하고 업데이트하고 있습니다.',
                description: '현재 페이지를 자동으로 다시 열지 않습니다.',
                failed: false,
            };
        case 'failed':
            return {
                title: '업데이트를 준비하지 못했습니다.',
                description: '현재 화면은 그대로 유지됩니다. 입력을 확인한 뒤 다시 시도하세요.',
                failed: true,
            };
        default: {
            const exhaustive: never = snapshot.status;
            return exhaustive;
        }
    }
}

export function PwaUpdateNotice({
    actionError,
    activating,
    onActivate,
    onRetry,
    snapshot,
}: {
    actionError: boolean;
    activating: boolean;
    onActivate: () => void;
    onRetry: () => void;
    snapshot: PwaUpdateSnapshot;
}) {
    const presentation = updatePresentation(snapshot, actionError);
    if (!presentation) return null;
    return (
        <Alert
            className="fixed top-[max(0.75rem,var(--safe-area-top))] right-[max(0.75rem,var(--safe-area-right))] left-[max(0.75rem,var(--safe-area-left))] z-[90] ml-auto max-w-lg bg-background shadow-xl sm:left-auto"
            role={presentation.failed ? 'alert' : 'status'}
            aria-live={presentation.failed ? 'assertive' : 'polite'}
            data-pwa-update-notice="true"
        >
            <RefreshCw
                aria-hidden="true"
                className={snapshot.status === 'installing' || activating ? 'animate-spin' : ''}
            />
            <AlertTitle>{presentation.title}</AlertTitle>
            <AlertDescription className="gap-3 text-base leading-6">
                <p>{presentation.description}</p>
                {snapshot.status === 'ready' ? (
                    <Button disabled={activating} size="sm" onClick={onActivate}>
                        {activating ? '업데이트 적용 중' : '입력 보존 후 업데이트'}
                    </Button>
                ) : null}
                {snapshot.status === 'failed' ? (
                    <Button size="sm" variant="outline" onClick={onRetry}>
                        업데이트 다시 준비
                    </Button>
                ) : null}
            </AlertDescription>
        </Alert>
    );
}

export function PwaUpdateController({
    bootstrap,
    children,
}: PropsWithChildren<{bootstrap: PwaUpdateBootstrap | null}>) {
    const [registrationFailed, setRegistrationFailed] = useState(false);
    const [actionError, setActionError] = useState(false);
    const [activating, setActivating] = useState(false);
    const subscribe = useCallback(
        (listener: () => void) => bootstrap?.subscribe(listener) ?? (() => undefined),
        [bootstrap],
    );
    const getSnapshot = useCallback(() => bootstrap?.getSnapshot() ?? IDLE_SNAPSHOT, [bootstrap]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_SNAPSHOT);

    useEffect(() => {
        let active = true;
        if (!bootstrap) return undefined;
        void bootstrap.ready.catch(() => {
            if (active) setRegistrationFailed(true);
        });
        return () => {
            active = false;
        };
    }, [bootstrap]);

    const visibleSnapshot = useMemo<PwaUpdateSnapshot>(
        () =>
            registrationFailed
                ? {status: 'failed', error: 'PWA_UPDATE_REGISTRATION_FAILED'}
                : snapshot,
        [registrationFailed, snapshot],
    );

    const activate = async (): Promise<void> => {
        if (!bootstrap) return;
        setActionError(false);
        setActivating(true);
        try {
            const result = await bootstrap.activateWhenSafe(() => preparePwaReload());
            if (result === 'cancelled') setActionError(true);
        } catch (error) {
            setActionError(!(error instanceof Error && error.message.startsWith('PWA_UPDATE_')));
        } finally {
            setActivating(false);
        }
    };

    const retry = async (): Promise<void> => {
        if (!bootstrap) return;
        setRegistrationFailed(false);
        setActionError(false);
        try {
            await bootstrap.retryObservation();
        } catch {
            setRegistrationFailed(true);
        }
    };

    return (
        <>
            {children}
            <PwaUpdateNotice
                actionError={actionError}
                activating={activating}
                snapshot={visibleSnapshot}
                onActivate={() => void activate()}
                onRetry={() => void retry()}
            />
        </>
    );
}
