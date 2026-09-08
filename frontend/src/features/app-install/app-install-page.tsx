import {Link} from '@tanstack/react-router';
import {
    ArrowLeft,
    BellRing,
    CircleAlert,
    Download,
    ExternalLink,
    KeyRound,
    LoaderCircle,
    Monitor,
    QrCode,
    RotateCcw,
    ShieldCheck,
    Smartphone,
    type LucideIcon,
} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';

import {DesktopAppMockup} from '@/components/app-showcase/desktop-app-mockup';
import {MobileNotificationMockup} from '@/components/app-showcase/mobile-notification-mockup';
import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {isMobileInstallClient} from '@/platform/pwa/install-client';

import {installStepOrder, type InstallStepId} from './install-step-order';

const PC_INSTALL_GUIDE_URL = 'https://github.com/YangSiJun528/jungle-bell#%EC%84%A4%EC%B9%98';

export type MobileInstallHandoffStatus = 'none' | 'preparing' | 'ready' | 'error';

const INSTALL_STEP_DETAILS: Record<
    InstallStepId,
    {number: number; eyebrow: string; title: string; icon: LucideIcon}
> = {
    pc: {number: 1, eyebrow: 'PC에서 먼저', title: 'PC 앱 설치·로그인', icon: Monitor},
    pairing: {number: 2, eyebrow: 'PC와 휴대폰 연결', title: 'QR 또는 코드로 연결', icon: QrCode},
    pwa: {number: 3, eyebrow: '휴대폰에서', title: 'PWA 설치', icon: Smartphone},
    push: {number: 4, eyebrow: '마지막 확인', title: '푸시 알림 테스트', icon: BellRing},
};

function currentClientIsMobile(): boolean {
    return typeof navigator !== 'undefined' && isMobileInstallClient(navigator);
}

function scrollToGuide(id: 'pc-install' | 'mobile-install'): void {
    document.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function InstallStepCard({
    id,
    current,
    children,
}: {
    id: InstallStepId;
    current: boolean;
    children: ReactNode;
}) {
    const {number, eyebrow, title, icon: Icon} = INSTALL_STEP_DETAILS[id];
    const elementId = id === 'pc' ? 'pc-install' : id === 'pwa' ? 'mobile-install' : `${id}-step`;

    return (
        <li
            id={elementId}
            className="min-w-0 scroll-mt-5"
            aria-current={current ? 'step' : undefined}
        >
            <Card className={current ? 'gap-0 border-primary/35 py-0 shadow-md' : 'gap-0 py-0'}>
                <CardHeader className="min-w-0 px-4 py-5 sm:px-6">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                            <Icon aria-hidden="true" className="size-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm leading-5 font-semibold text-primary">
                                {current ? '현재 단계 · ' : ''}
                                {number}. {eyebrow}
                            </p>
                            <h2 className="mt-0.5 text-xl leading-7 font-bold tracking-tight break-words">
                                {title}
                            </h2>
                            {id === 'pc' ? (
                                <p className="mt-2 w-fit max-w-full rounded-full bg-primary/10 px-2.5 py-1 text-sm leading-5 font-semibold whitespace-normal text-primary">
                                    출석·개인 알림에 필요
                                </p>
                            ) : null}
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="min-w-0 px-4 pb-5 sm:px-6 sm:pb-6">{children}</CardContent>
            </Card>
        </li>
    );
}

function MobileInstallHandoffNotice({status}: {status: MobileInstallHandoffStatus}) {
    if (status === 'none') return null;

    const content =
        status === 'preparing'
            ? {
                  icon: (
                      <LoaderCircle
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 animate-spin"
                      />
                  ),
                  title: 'PC 연결 정보를 준비하고 있습니다.',
                  description: '준비가 끝난 뒤 앱을 설치해 주세요.',
                  className: 'bg-muted/55 text-muted-foreground',
              }
            : status === 'ready'
              ? {
                    icon: <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />,
                    title: '설치 준비가 완료됐습니다.',
                    description:
                        '설치 후 홈 화면의 Jungle Bell을 열면 PC 연결 요청이 자동으로 시작됩니다.',
                    className: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
                }
              : {
                    icon: <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />,
                    title: 'QR 연결 정보를 준비하지 못했습니다.',
                    description: '네트워크를 확인해 다시 시도하거나 PC에서 새 QR을 만들어 주세요.',
                    className: 'bg-destructive/10 text-destructive',
                };

    return (
        <div
            className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-base ${content.className}`}
            aria-live="polite"
        >
            {content.icon}
            <div className="min-w-0">
                <strong className="block">{content.title}</strong>
                <p className="mt-1 leading-5">{content.description}</p>
            </div>
        </div>
    );
}

function MobileInstallAction({
    status,
    mobileClient,
    onRequestMobileInstall,
    onRetryMobileHandoff,
}: {
    status: MobileInstallHandoffStatus;
    mobileClient: boolean;
    onRequestMobileInstall?: () => void;
    onRetryMobileHandoff?: () => void;
}) {
    const className = 'min-h-11 w-full whitespace-normal sm:w-auto';
    if (status === 'preparing') {
        return (
            <Button className={className} variant="outline" disabled>
                연결 정보 준비 중<LoaderCircle aria-hidden="true" className="animate-spin" />
            </Button>
        );
    }
    if (status === 'error') {
        return (
            <Button
                className={className}
                variant="outline"
                onClick={onRetryMobileHandoff}
                disabled={!onRetryMobileHandoff}
            >
                다시 준비
                <RotateCcw aria-hidden="true" />
            </Button>
        );
    }
    if (onRequestMobileInstall) {
        return (
            <Button className={className} onClick={onRequestMobileInstall}>
                PWA 설치 시작
                <Download aria-hidden="true" />
            </Button>
        );
    }
    if (mobileClient) {
        return (
            <Button asChild className={className} variant="outline">
                <Link to="/connections">
                    설치됨 · 푸시 설정 열기
                    <BellRing aria-hidden="true" />
                </Link>
            </Button>
        );
    }
    return (
        <Button className={className} variant="outline" disabled>
            모바일에서만 이용 가능
            <Smartphone aria-hidden="true" />
        </Button>
    );
}

function PcInstallStep({mobileClient}: {mobileClient: boolean}) {
    return (
        <div
            className={
                mobileClient
                    ? 'min-w-0'
                    : 'grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_15rem] md:items-center'
            }
        >
            <div className="min-w-0">
                <p className="text-base leading-7 text-muted-foreground">
                    {mobileClient
                        ? '출석 자동 확인과 개인 알림을 연결하려면 PC 앱 설치와 Jungle Campus 로그인을 먼저 완료하세요.'
                        : '운영체제에 맞는 PC 앱을 설치한 뒤 Jungle Campus에 로그인합니다. 공개 세탁실과 식단만 볼 때는 이 단계가 필요하지 않습니다.'}
                </p>
                <Button asChild className="mt-4 h-auto min-h-11 w-full whitespace-normal sm:w-auto">
                    <a href={PC_INSTALL_GUIDE_URL} target="_blank" rel="noopener noreferrer">
                        PC 앱 설치 가이드
                        <ExternalLink aria-hidden="true" />
                    </a>
                </Button>
            </div>
            {mobileClient ? null : (
                <DesktopAppMockup compact className="min-h-56 w-full shadow-none" />
            )}
        </div>
    );
}

function PairingStep() {
    return (
        <div className="min-w-0">
            <p className="text-base leading-7 text-muted-foreground">
                PC 앱의 모바일 연결 화면에서 QR을 만들고 휴대폰으로 스캔하세요. 카메라를 사용할 수
                없으면 화면에 표시된 연결 코드를 직접 입력할 수 있습니다.
            </p>
            <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-lg border bg-muted/35 p-4">
                    <QrCode aria-hidden="true" className="size-5 text-primary" />
                    <strong className="mt-2 block text-base">QR 스캔</strong>
                    <p className="mt-1 text-base leading-6 text-muted-foreground">
                        PC에 표시된 QR을 휴대폰 카메라로 엽니다.
                    </p>
                </div>
                <div className="min-w-0 rounded-lg border bg-muted/35 p-4">
                    <KeyRound aria-hidden="true" className="size-5 text-primary" />
                    <strong className="mt-2 block text-base">연결 코드 입력</strong>
                    <p className="mt-1 text-base leading-6 text-muted-foreground">
                        QR을 읽지 못하면 같은 화면의 코드를 입력합니다.
                    </p>
                </div>
            </div>
        </div>
    );
}

function PwaInstallStep({
    mobileClient,
    mobileHandoffStatus,
    onRequestMobileInstall,
    onRetryMobileHandoff,
}: {
    mobileClient: boolean;
    mobileHandoffStatus: MobileInstallHandoffStatus;
    onRequestMobileInstall?: () => void;
    onRetryMobileHandoff?: () => void;
}) {
    return (
        <div className="min-w-0">
            <p className="text-base leading-7 text-muted-foreground">
                {mobileClient
                    ? '지금 이 브라우저에서 Jungle Bell을 홈 화면에 설치하세요. PC 앱 설치·로그인과 QR 또는 코드 연결이 끝나지 않았다면 설치 후 이어서 완료할 수 있습니다.'
                    : '연결할 휴대폰에서 이 페이지를 열고 Jungle Bell을 홈 화면에 설치합니다.'}
            </p>
            <MobileInstallHandoffNotice status={mobileHandoffStatus} />
            <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
                <MobileInstallAction
                    status={mobileHandoffStatus}
                    mobileClient={mobileClient}
                    onRequestMobileInstall={onRequestMobileInstall}
                    onRetryMobileHandoff={onRetryMobileHandoff}
                />
                <details className="min-w-0 flex-1 rounded-lg border bg-muted/30">
                    <summary className="flex min-h-11 cursor-pointer items-center px-4 py-2 text-base font-semibold">
                        수동 설치 방법
                    </summary>
                    <div className="grid gap-2 border-t px-4 py-3 text-base leading-6 text-muted-foreground">
                        <p>iPhone·iPad: Safari 공유 메뉴에서 ‘홈 화면에 추가’를 선택합니다.</p>
                        <p>
                            Android: 브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택합니다.
                        </p>
                    </div>
                </details>
            </div>
        </div>
    );
}

function PushTestStep() {
    return (
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_12rem] md:items-center">
            <div className="min-w-0">
                <p className="text-base leading-7 text-muted-foreground">
                    설치한 PWA에서 알림 권한을 허용하고 이 기기로 테스트 알림을 보냅니다. 실제로
                    도착한 것을 확인해야 설정이 끝납니다.
                </p>
                <Button
                    asChild
                    className="mt-4 h-auto min-h-11 w-full whitespace-normal sm:w-auto"
                    variant="outline"
                >
                    <Link to="/connections">
                        푸시 설정과 테스트 열기
                        <BellRing aria-hidden="true" />
                    </Link>
                </Button>
            </div>
            <MobileNotificationMockup
                phone
                className="hidden min-h-64 w-full shadow-none md:block"
            />
        </div>
    );
}

function installStepContent(
    id: InstallStepId,
    options: {
        mobileClient: boolean;
        mobileHandoffStatus: MobileInstallHandoffStatus;
        onRequestMobileInstall?: () => void;
        onRetryMobileHandoff?: () => void;
    },
): ReactNode {
    switch (id) {
        case 'pc':
            return <PcInstallStep mobileClient={options.mobileClient} />;
        case 'pairing':
            return <PairingStep />;
        case 'pwa':
            return <PwaInstallStep {...options} />;
        case 'push':
            return <PushTestStep />;
    }
    return null;
}

export function AppInstallPage({
    onRequestMobileInstall,
    focusMobileInstall = false,
    mobileHandoffStatus = 'none',
    onRetryMobileHandoff,
}: {
    onRequestMobileInstall?: () => void;
    focusMobileInstall?: boolean;
    mobileHandoffStatus?: MobileInstallHandoffStatus;
    onRetryMobileHandoff?: () => void;
}) {
    const [mobileClient] = useState(currentClientIsMobile);

    useEffect(() => {
        if (!focusMobileInstall) return undefined;
        const frame = window.requestAnimationFrame(() => scrollToGuide('mobile-install'));
        return () => window.cancelAnimationFrame(frame);
    }, [focusMobileInstall]);

    const steps = installStepOrder(mobileClient);
    const contentOptions = {
        mobileClient,
        mobileHandoffStatus,
        onRequestMobileInstall,
        onRetryMobileHandoff,
    };

    return (
        <div className="min-w-0 space-y-6 sm:space-y-8">
            <PageHeader
                title="앱 설치 안내"
                actions={
                    <Button asChild variant="outline">
                        <Link to="/home">
                            <ArrowLeft aria-hidden="true" />
                            대시보드로 돌아가기
                        </Link>
                    </Button>
                }
            />

            <section
                className="min-w-0 rounded-xl border bg-primary/5 p-4 sm:p-6"
                aria-labelledby="install-guide-title"
            >
                <p className="text-sm font-semibold text-primary">출석·개인 알림 설정</p>
                <h2
                    id="install-guide-title"
                    className="mt-1 text-2xl leading-8 font-bold tracking-[-0.035em] break-words sm:text-3xl sm:leading-10"
                >
                    네 단계로 PC와 휴대폰 연결하기
                </h2>
                <p className="mt-2 max-w-3xl text-base leading-7 text-muted-foreground">
                    세탁실·식단은 설치 없이 바로 볼 수 있습니다. 아래 과정은 출석 자동 확인과 개인
                    알림을 사용할 때만 필요합니다.
                </p>
            </section>

            <ol className="grid min-w-0 gap-4" aria-label="Jungle Bell 설치 단계">
                {steps.map((id, index) => (
                    <InstallStepCard key={id} id={id} current={mobileClient && index === 0}>
                        {installStepContent(id, contentOptions)}
                    </InstallStepCard>
                ))}
            </ol>
        </div>
    );
}

export default AppInstallPage;
