import {Link} from '@tanstack/react-router';
import {Check, Link2, Smartphone} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {
    InstallPrompt,
    useInstallPromptVisibility,
} from '@/platform/pwa/install-prompt';
import {CompanionConnections} from './connections-page';

const SETUP_STEPS = [
    'PC 연결',
    '앱 설치',
    '알림 확인',
] as const;

export function MobileSetupPage() {
    const {platform} = useDashboardEnvironment();
    const {installPromptOpen, openInstallPrompt, setInstallPromptVisibility} = useInstallPromptVisibility();
    const mobileBrowser = platform.kind === 'browser' && platform.pwa.isMobileInstallClient();

    if (!mobileBrowser && !platform.pwa.installed) {
        return (
            <main className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground">
                <div className="w-full max-w-lg space-y-5 rounded-xl border bg-card p-6 text-center shadow-sm">
                    <Smartphone aria-hidden="true" className="mx-auto size-8 text-primary"/>
                    <div>
                        <h1 className="text-xl font-bold">휴대폰에서 설정해 주세요.</h1>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            PC 화면의 QR을 iPhone 또는 Android 카메라로 스캔하면 설정을 시작합니다.
                        </p>
                    </div>
                    <Button asChild variant="outline"><Link to="/home">홈으로 돌아가기</Link></Button>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-svh bg-background px-4 py-8 text-foreground sm:py-12">
            <div className="mx-auto w-full max-w-2xl space-y-7">
                <header className="text-center">
                    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Link2 aria-hidden="true" className="size-6"/>
                    </span>
                    <h1 className="mt-4 text-2xl font-bold tracking-tight">Jungle Bell 휴대폰 설정</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        PC 연결부터 앱 설치와 알림 확인까지 순서대로 진행합니다.
                    </p>
                </header>

                <ol className="grid grid-cols-3 gap-2" aria-label="휴대폰 설정 단계">
                    {SETUP_STEPS.map((step, index) => (
                        <li key={step} className="rounded-lg border bg-card px-2 py-3 text-center text-xs font-medium sm:text-sm">
                            <span className="mb-1 block text-primary">{index + 1}</span>
                            {step}
                        </li>
                    ))}
                </ol>

                <CompanionConnections
                    completionPath={null}
                    mode="setup"
                    onRequestMobileInstall={platform.pwa.installed ? undefined : openInstallPrompt}
                />

                <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                    <Check aria-hidden="true" className="size-3.5"/>
                    QR 비밀값은 기기에 저장하지 않고 PC 승인 후 한 번만 사용합니다.
                </p>
            </div>
            <InstallPrompt open={installPromptOpen} onOpenChange={setInstallPromptVisibility}/>
        </main>
    );
}
