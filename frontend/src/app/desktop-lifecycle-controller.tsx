import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    type PropsWithChildren,
} from 'react';

import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {Button} from '@/components/ui/button';
import type {PlatformAdapter} from '@/platform/contracts';
import type {DesktopLifecycleStatus, TauriLifecycleAdapter} from '@/platform/tauri/lifecycle';

export interface DesktopLifecycleState {
    readonly phase: 'checking' | 'ready' | 'unavailable';
    readonly status: DesktopLifecycleStatus | null;
    readonly noticeOpen: boolean;
    readonly detailsOpen: boolean;
    readonly operation: 'idle' | 'acknowledging' | 'quitting';
    readonly error: 'DESKTOP_LIFECYCLE_ACTION_FAILED' | 'DESKTOP_LIFECYCLE_STATUS_FAILED' | null;
}

type DesktopLifecycleAction =
    | {type: 'unavailable'}
    | {type: 'status-loaded'; status: DesktopLifecycleStatus}
    | {type: 'status-failed'}
    | {type: 'close-requested'; status: DesktopLifecycleStatus}
    | {type: 'show-details'}
    | {type: 'hide-details'}
    | {type: 'acknowledge-started'}
    | {type: 'acknowledge-succeeded'; status: DesktopLifecycleStatus}
    | {type: 'quit-started'}
    | {type: 'quit-returned'}
    | {type: 'operation-failed'};

export const initialDesktopLifecycleState: DesktopLifecycleState = {
    phase: 'checking',
    status: null,
    noticeOpen: false,
    detailsOpen: false,
    operation: 'idle',
    error: null,
};

export function desktopLifecycleTransition(
    state: DesktopLifecycleState,
    action: DesktopLifecycleAction,
): DesktopLifecycleState {
    switch (action.type) {
        case 'unavailable':
            return {...initialDesktopLifecycleState, phase: 'unavailable'};
        case 'status-loaded':
            if (
                state.noticeOpen &&
                state.status?.closeToTrayNotice === 'pending' &&
                action.status.closeToTrayNotice === 'unseen'
            ) {
                return {...state, phase: 'ready'};
            }
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: action.status.closeToTrayNotice === 'pending',
                error: null,
            };
        case 'status-failed':
            return {...state, phase: 'ready', error: 'DESKTOP_LIFECYCLE_STATUS_FAILED'};
        case 'close-requested':
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: true,
                detailsOpen: false,
                error: null,
            };
        case 'show-details':
            return {...state, detailsOpen: true, error: null};
        case 'hide-details':
            return {...state, detailsOpen: false, error: null};
        case 'acknowledge-started':
            return {...state, operation: 'acknowledging', error: null};
        case 'acknowledge-succeeded':
            return {
                ...state,
                phase: 'ready',
                status: action.status,
                noticeOpen: false,
                detailsOpen: false,
                operation: 'idle',
                error: null,
            };
        case 'quit-started':
            return {...state, operation: 'quitting', error: null};
        case 'quit-returned':
            return {...state, operation: 'idle'};
        case 'operation-failed':
            return {
                ...state,
                operation: 'idle',
                error: 'DESKTOP_LIFECYCLE_ACTION_FAILED',
            };
        default: {
            const exhaustive: never = action;
            return exhaustive;
        }
    }
}

function isTauriLifecycleAdapter(value: unknown): value is TauriLifecycleAdapter {
    return (
        typeof value === 'object' &&
        value !== null &&
        'getStatus' in value &&
        typeof value.getStatus === 'function' &&
        'acknowledgeAndHideToTray' in value &&
        typeof value.acknowledgeAndHideToTray === 'function' &&
        'quit' in value &&
        typeof value.quit === 'function' &&
        'subscribeCloseToTrayNotice' in value &&
        typeof value.subscribeCloseToTrayNotice === 'function'
    );
}

function lifecycleAdapter(platform: PlatformAdapter): TauriLifecycleAdapter | null {
    if (platform.kind !== 'desktop' || !('lifecycle' in platform)) return null;
    const candidate = platform.lifecycle;
    return isTauriLifecycleAdapter(candidate) ? candidate : null;
}

export interface DesktopLifecycleControls {
    readonly state: DesktopLifecycleState;
    acknowledgeAndHide(): Promise<void>;
    quit(): Promise<void>;
    showDetails(): void;
    hideDetails(): void;
}

const DesktopLifecycleContext = createContext<DesktopLifecycleControls | null>(null);

export function useDesktopLifecycleControls(): DesktopLifecycleControls {
    const controls = useContext(DesktopLifecycleContext);
    if (!controls) throw new Error('DESKTOP_LIFECYCLE_CONTEXT_REQUIRED');
    return controls;
}

function DesktopCloseToTrayNotice({controls}: {controls: DesktopLifecycleControls}) {
    const {state} = controls;
    const requiredAction = state.noticeOpen;
    const open = requiredAction || state.detailsOpen;

    return (
        <AlertDialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && !requiredAction) controls.hideDetails();
            }}
        >
            <AlertDialogContent
                data-desktop-lifecycle-notice="true"
                onEscapeKeyDown={(event) => {
                    if (requiredAction) event.preventDefault();
                }}
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>닫기 버튼은 앱을 트레이로 숨깁니다</AlertDialogTitle>
                    <AlertDialogDescription className="text-base leading-6">
                        트레이에 숨기면 출석 확인과 알림이 계속 동작합니다. 앱을 완전히 끝내려면
                        아래의 완전 종료를 선택하세요.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {state.error ? (
                    <p className="text-base leading-6 text-destructive" role="alert">
                        요청을 완료하지 못했습니다. 잠시 뒤 다시 시도하세요.
                    </p>
                ) : null}
                <AlertDialogFooter>
                    {requiredAction ? (
                        <>
                            <Button
                                variant="outline"
                                disabled={state.operation !== 'idle'}
                                onClick={() => void controls.quit()}
                            >
                                {state.operation === 'quitting' ? '종료 중' : '완전히 종료'}
                            </Button>
                            <Button
                                disabled={state.operation !== 'idle'}
                                onClick={() => void controls.acknowledgeAndHide()}
                            >
                                {state.operation === 'acknowledging'
                                    ? '트레이로 숨기는 중'
                                    : '확인하고 트레이로 숨기기'}
                            </Button>
                        </>
                    ) : (
                        <Button onClick={() => controls.hideDetails()}>확인</Button>
                    )}
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

export function DesktopLifecycleController({
    children,
    platform,
}: PropsWithChildren<{platform: PlatformAdapter}>) {
    const adapter = useMemo(() => lifecycleAdapter(platform), [platform]);
    const [state, dispatch] = useReducer(
        desktopLifecycleTransition,
        adapter
            ? initialDesktopLifecycleState
            : {...initialDesktopLifecycleState, phase: 'unavailable'},
    );

    useEffect(() => {
        if (!adapter) {
            dispatch({type: 'unavailable'});
            return undefined;
        }

        let active = true;
        let unsubscribe: (() => void) | undefined;
        void adapter
            .subscribeCloseToTrayNotice((status) => {
                if (active && status.closeToTrayNotice === 'pending') {
                    dispatch({type: 'close-requested', status});
                }
            })
            .then((dispose) => {
                if (active) unsubscribe = dispose;
                else dispose();
                return undefined;
            })
            .catch(() => {
                if (active) dispatch({type: 'status-failed'});
            });
        void adapter
            .getStatus()
            .then((status) => {
                if (active) dispatch({type: 'status-loaded', status});
                return undefined;
            })
            .catch(() => {
                if (active) dispatch({type: 'status-failed'});
            });

        return () => {
            active = false;
            unsubscribe?.();
        };
    }, [adapter]);

    const controls = useMemo<DesktopLifecycleControls>(
        () => ({
            state,
            async acknowledgeAndHide() {
                if (!adapter) return;
                dispatch({type: 'acknowledge-started'});
                try {
                    const status = await adapter.acknowledgeAndHideToTray();
                    dispatch({type: 'acknowledge-succeeded', status});
                } catch {
                    dispatch({type: 'operation-failed'});
                }
            },
            async quit() {
                if (!adapter) return;
                dispatch({type: 'quit-started'});
                try {
                    await adapter.quit();
                    dispatch({type: 'quit-returned'});
                } catch {
                    dispatch({type: 'operation-failed'});
                }
            },
            showDetails: () => dispatch({type: 'show-details'}),
            hideDetails: () => dispatch({type: 'hide-details'}),
        }),
        [adapter, state],
    );

    return (
        <DesktopLifecycleContext.Provider value={controls}>
            {children}
            {adapter ? <DesktopCloseToTrayNotice controls={controls} /> : null}
        </DesktopLifecycleContext.Provider>
    );
}

export function DesktopLifecycleSummary() {
    const controls = useDesktopLifecycleControls();
    if (controls.state.phase === 'unavailable') return null;
    return (
        <section className="rounded-lg border bg-card p-4" aria-label="PC 앱 종료 동작">
            <p className="text-base leading-6">X를 누르면 앱을 종료하지 않고 트레이로 숨깁니다.</p>
            <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => controls.showDetails()}
            >
                종료 동작 다시 보기
            </Button>
        </section>
    );
}
