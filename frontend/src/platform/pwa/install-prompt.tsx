import {BadgeCheck, CircleAlert, Download, MonitorDown, RotateCcw, X} from 'lucide-react';
import {useCallback, useEffect, useReducer, useState, type ReactNode} from 'react';

import {useDashboardEnvironment} from '@/app/dashboard-context';
import {Button} from '@/components/ui/button';
import {Card, CardContent} from '@/components/ui/card';

import {
    initialInstallPromptState,
    reduceInstallPromptState,
    type InstallPromptState,
    type InstallPromptStatus,
} from './install-prompt-state';

interface InstallPromptProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const RELEASE_URL = 'https://github.com/YangSiJun528/jungle-bell/releases/latest';

export function useInstallPromptVisibility(): {
    installPromptOpen: boolean;
    openInstallPrompt: () => void;
    setInstallPromptVisibility: (open: boolean) => void;
} {
    const [installPromptOpen, setInstallPromptOpen] = useState(false);

    const setInstallPromptVisibility = useCallback((open: boolean) => {
        setInstallPromptOpen(open);
    }, []);

    const openInstallPrompt = useCallback(() => {
        setInstallPromptVisibility(true);
    }, [setInstallPromptVisibility]);

    return {installPromptOpen, openInstallPrompt, setInstallPromptVisibility};
}

function ManualInstallGuide() {
    return (
        <details className="w-full min-w-0 rounded-lg border bg-muted/30" open>
            <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-base font-semibold">
                수동 설치 방법
            </summary>
            <div className="grid gap-1 border-t px-3 py-2 text-base leading-6 text-muted-foreground">
                <p>iPhone·iPad: Safari 공유 메뉴에서 ‘홈 화면에 추가’를 선택하세요.</p>
                <p>Android: 브라우저 메뉴에서 ‘앱 설치’를 선택하세요.</p>
            </div>
        </details>
    );
}

function mobileInstallPresentation(
    status: InstallPromptStatus,
    installRechecked: boolean,
): {
    title: string;
    description: string;
} {
    switch (status) {
        case 'available':
            return {
                title: 'Jungle Bell을 홈 화면에 추가',
                description: '설치를 누르면 브라우저의 PWA 설치 화면이 열립니다.',
            };
        case 'dismissed':
            return {
                title: '설치를 취소했습니다.',
                description:
                    '다시 확인하거나 아래 수동 설치 방법으로 언제든 홈 화면에 추가할 수 있습니다.',
            };
        case 'completed':
            return {
                title: '설치 요청을 완료했습니다.',
                description: '홈 화면에서 Jungle Bell을 열고 연결과 푸시 테스트를 이어가세요.',
            };
        case 'already-installed':
            return {
                title: 'Jungle Bell이 이미 설치되어 있습니다.',
                description: '홈 화면의 Jungle Bell에서 개인 기능을 사용할 수 있습니다.',
            };
        case 'unsupported':
            return {
                title: '자동 설치를 사용할 수 없습니다.',
                description: installRechecked
                    ? '다시 확인했지만 자동 설치 버튼이 없습니다. 아래 방법으로 직접 설치하세요.'
                    : '브라우저가 설치 버튼을 제공하지 않았습니다. 아래 방법으로 직접 설치하세요.',
            };
    }
    throw new Error('INSTALL_PROMPT_STATUS_INVALID');
}

function MobileInstallStatusIcon({status}: {status: InstallPromptStatus}) {
    if (status === 'completed' || status === 'already-installed') {
        return <BadgeCheck aria-hidden="true" className="size-5" />;
    }
    if (status === 'dismissed') {
        return <RotateCcw aria-hidden="true" className="size-5" />;
    }
    if (status === 'unsupported') {
        return <CircleAlert aria-hidden="true" className="size-5" />;
    }
    return <Download aria-hidden="true" className="size-5" />;
}

function MobileInstallActions({
    state,
    onInstall,
    onRetry,
    onClose,
}: {
    state: InstallPromptState;
    onInstall: () => void;
    onRetry: () => void;
    onClose: () => void;
}) {
    let action: ReactNode;
    switch (state.status) {
        case 'available':
            action = (
                <Button
                    className="h-auto min-h-11 w-full whitespace-normal sm:w-auto"
                    onClick={onInstall}
                >
                    <Download aria-hidden="true" className="size-4" />홈 화면에 추가
                </Button>
            );
            break;
        case 'dismissed':
            action = (
                <Button
                    className="h-auto min-h-11 w-full whitespace-normal sm:w-auto"
                    variant="outline"
                    onClick={onRetry}
                >
                    <RotateCcw aria-hidden="true" className="size-4" />
                    설치 다시 시도
                </Button>
            );
            break;
        case 'unsupported':
            action = (
                <Button
                    className="h-auto min-h-11 w-full whitespace-normal sm:w-auto"
                    variant="outline"
                    onClick={onRetry}
                >
                    <RotateCcw aria-hidden="true" className="size-4" />
                    설치 가능 여부 다시 확인
                </Button>
            );
            break;
        case 'completed':
        case 'already-installed':
            action = (
                <Button className="min-h-11 w-full sm:w-auto" variant="outline" onClick={onClose}>
                    확인
                </Button>
            );
            break;
    }

    const showManualGuide = state.status === 'unsupported' || state.status === 'dismissed';
    return (
        <>
            {action}
            {showManualGuide ? <ManualInstallGuide /> : null}
        </>
    );
}

export function InstallPrompt({open, onOpenChange}: InstallPromptProps) {
    const {platform} = useDashboardEnvironment();
    const [state, dispatch] = useReducer(
        reduceInstallPromptState,
        platform.pwa.installed,
        initialInstallPromptState,
    );
    const [mobile] = useState(() => platform.pwa.isMobileInstallClient());
    const [installRechecked, setInstallRechecked] = useState(false);

    useEffect(() => {
        if (!platform.pwa.available) return undefined;
        const unlistenPrompt = platform.pwa.subscribeInstallPrompt((prompt) => {
            setInstallRechecked(false);
            dispatch({type: 'prompt-available', prompt});
        });
        const handleInstalled = () => dispatch({type: 'app-installed'});
        window.addEventListener('appinstalled', handleInstalled);
        return () => {
            unlistenPrompt();
            window.removeEventListener('appinstalled', handleInstalled);
        };
    }, [platform.pwa]);

    if (!platform.pwa.available) return null;
    if (!open) return null;

    const requestInstall = async () => {
        if (state.status !== 'available') return;
        try {
            const choice = await state.prompt.prompt();
            dispatch({type: choice === 'accepted' ? 'prompt-accepted' : 'prompt-dismissed'});
        } catch {
            dispatch({type: 'prompt-failed'});
        }
    };

    const mobileContent = mobileInstallPresentation(state.status, installRechecked);

    const title = mobile ? mobileContent.title : 'PC 앱으로 개인 기능 사용';
    const description = mobile
        ? mobileContent.description
        : '출석 상태 갱신과 운영체제 알림을 사용하려면 PC 앱을 설치하세요.';

    return (
        <Card className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 mx-auto max-w-2xl gap-0 border-primary/25 bg-card/96 py-3 shadow-xl backdrop-blur md:bottom-5">
            <CardContent className="grid min-w-0 gap-3 px-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start sm:px-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    {mobile ? (
                        <MobileInstallStatusIcon status={state.status} />
                    ) : (
                        <MonitorDown aria-hidden="true" className="size-5" />
                    )}
                </span>
                <div className="min-w-0" aria-live="polite">
                    <strong className="block text-base leading-6">{title}</strong>
                    <span className="block text-base leading-6 text-muted-foreground">
                        {description}
                    </span>
                </div>
                <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-1 right-1 size-11 sm:static"
                    aria-label="설치 안내 닫기"
                    onClick={() => onOpenChange(false)}
                >
                    <X aria-hidden="true" className="size-4" />
                </Button>

                <div className="col-span-full flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:pl-14">
                    {mobile ? (
                        <MobileInstallActions
                            state={state}
                            onInstall={() => void requestInstall()}
                            onRetry={() => {
                                dispatch({type: 'retry'});
                                setInstallRechecked(true);
                            }}
                            onClose={() => onOpenChange(false)}
                        />
                    ) : (
                        <Button asChild className="min-h-11 w-full sm:w-auto">
                            <a href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
                                <Download aria-hidden="true" className="size-4" />
                                PC 앱 다운로드
                            </a>
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
