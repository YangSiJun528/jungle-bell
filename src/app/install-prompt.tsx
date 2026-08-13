import {useCallback, useEffect, useState} from 'react';
import {Download, MonitorDown, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, CardContent} from '@/components/ui/card';
import {useDashboardEnvironment} from './dashboard-context';
import {isMobileInstallClient} from './install-client';

interface InstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

interface InstallPromptProps {
    open: boolean;
    onOpenChange(open: boolean): void;
}

const RELEASE_URL = 'https://github.com/YangSiJun528/jungle-bell/releases/latest';

export function useInstallPromptVisibility(): {
    installPromptOpen: boolean;
    openInstallPrompt(): void;
    setInstallPromptVisibility(open: boolean): void;
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

export function InstallPrompt({open, onOpenChange}: InstallPromptProps) {
    const {platform} = useDashboardEnvironment();
    const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
    const [mobile] = useState(() => isMobileInstallClient(navigator));

    useEffect(() => {
        if (platform.kind !== 'browser') return;
        const listener = (event: Event) => {
            event.preventDefault();
            setPrompt(event as InstallPromptEvent);
        };
        window.addEventListener('beforeinstallprompt', listener);
        return () => window.removeEventListener('beforeinstallprompt', listener);
    }, [platform.kind]);

    if (platform.kind !== 'browser') return null;
    if (!open) return null;

    const title = mobile ? '홈 화면에 Jungle Bell 추가' : 'PC 앱으로 개인 기능 사용';
    const description = mobile
        ? prompt
            ? '설치를 누르면 Jungle Bell이 홈 화면에 추가됩니다.'
            : 'iPhone·iPad는 공유 메뉴에서 ‘홈 화면에 추가’를, Android는 브라우저 메뉴에서 ‘앱 설치’를 선택하세요.'
        : '출석 상태 갱신과 운영체제 알림을 사용하려면 PC 앱을 설치하세요.';

    return (
        <Card className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 mx-auto max-w-2xl border-primary/25 bg-card/96 py-3 shadow-xl backdrop-blur md:bottom-5">
            <CardContent className="flex flex-col gap-3 px-3 sm:flex-row sm:items-center sm:px-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <MonitorDown aria-hidden="true" className="size-5"/>
                </span>
                <div className="min-w-0 flex-1">
                    <strong className="block text-sm">{title}</strong>
                    <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                    {mobile && prompt ? (
                        <Button
                            size="sm"
                            onClick={async () => {
                                await prompt.prompt();
                                const choice = await prompt.userChoice;
                                setPrompt(null);
                                if (choice.outcome === 'accepted') onOpenChange(false);
                            }}
                        >
                            <Download aria-hidden="true" className="size-4"/>홈 화면에 추가
                        </Button>
                    ) : !mobile ? (
                        <Button asChild size="sm">
                            <a href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
                                <Download aria-hidden="true" className="size-4"/>PC 앱 다운로드
                            </a>
                        </Button>
                    ) : null}
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="설치 안내 닫기"
                        onClick={() => onOpenChange(false)}
                    >
                        <X aria-hidden="true" className="size-4"/>
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
