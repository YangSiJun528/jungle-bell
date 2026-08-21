import {Link} from '@tanstack/react-router';
import {
    ArrowLeft,
    CircleAlert,
    Download,
    ExternalLink,
    LoaderCircle,
    Monitor,
    RotateCcw,
    ShieldCheck,
    Smartphone,
    type LucideIcon,
} from 'lucide-react';
import {useEffect, type ReactNode} from 'react';

import {DesktopAppMockup} from '@/components/app-showcase/desktop-app-mockup';
import {MobileNotificationMockup} from '@/components/app-showcase/mobile-notification-mockup';
import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';

const PC_INSTALL_GUIDE_URL = 'https://github.com/YangSiJun528/jungle-bell#%EC%84%A4%EC%B9%98';

export type MobileInstallHandoffStatus = 'none' | 'preparing' | 'ready' | 'error';

function scrollToGuide(id: 'pc-install' | 'mobile-install'): void {
    document.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function DeviceCard({
    icon: Icon,
    eyebrow,
    title,
    badge,
    children,
    action,
    emphasized = false,
}: {
    icon: LucideIcon;
    eyebrow: string;
    title: string;
    badge?: string;
    children: ReactNode;
    action: ReactNode;
    emphasized?: boolean;
}) {
    return (
        <Card className={emphasized ? 'gap-0 border-primary/30 py-0 shadow-lg' : 'gap-0 py-0'}>
            <CardHeader className="flex-row items-center gap-3 px-5 py-5 sm:px-6">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Icon aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-primary">{eyebrow}</p>
                    <h3 className="text-xl font-bold tracking-tight">{title}</h3>
                </div>
                {badge ? (
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                        {badge}
                    </span>
                ) : null}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4 px-5 pb-5 sm:px-6 sm:pb-6">
                {children}
                <div className="mt-auto">{action}</div>
            </CardContent>
        </Card>
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
            className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${content.className}`}
            aria-live="polite"
        >
            {content.icon}
            <div>
                <strong className="block">{content.title}</strong>
                <p className="mt-1 leading-5">{content.description}</p>
            </div>
        </div>
    );
}

function MobileInstallAction({
    status,
    onRequestMobileInstall,
    onRetryMobileHandoff,
}: {
    status: MobileInstallHandoffStatus;
    onRequestMobileInstall?: () => void;
    onRetryMobileHandoff?: () => void;
}) {
    const className = 'mt-4 w-full shrink-0 sm:mt-0 sm:w-auto';
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
            <Button className={className} variant="outline" onClick={onRequestMobileInstall}>
                모바일 앱 설치 안내 열기
                <Smartphone aria-hidden="true" />
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
    useEffect(() => {
        if (!focusMobileInstall) return undefined;
        const frame = window.requestAnimationFrame(() => scrollToGuide('mobile-install'));
        return () => window.cancelAnimationFrame(frame);
    }, [focusMobileInstall]);

    return (
        <div className="space-y-8">
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
                className="mx-auto max-w-4xl py-3 text-center"
                aria-labelledby="install-hero-title"
            >
                <h2
                    id="install-hero-title"
                    className="text-3xl leading-tight font-bold tracking-[-0.045em] text-balance sm:text-5xl"
                >
                    PC·모바일 앱으로 Jungle Bell을{' '}
                    <span className="text-primary">더 편리하게 사용하세요.</span>
                </h2>
                <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-pretty text-muted-foreground sm:text-base sm:leading-7">
                    데스크톱에서는 출석 상태를 자동으로 확인하고, 모바일에서는 출석·세탁·식사 생활
                    알림을 잠금 화면에서 받아볼 수 있어요.
                </p>
            </section>

            <section
                className="grid min-w-0 gap-4 lg:grid-cols-2"
                aria-label="기기별 Jungle Bell 앱 안내"
            >
                <DeviceCard
                    icon={Monitor}
                    eyebrow="출석 상태 확인"
                    title="PC 앱"
                    badge="필수"
                    emphasized
                    action={
                        <Button className="w-full" onClick={() => scrollToGuide('pc-install')}>
                            내 PC 설치 방법 보기
                            <Download aria-hidden="true" />
                        </Button>
                    }
                >
                    <DesktopAppMockup />
                </DeviceCard>

                <DeviceCard
                    icon={Smartphone}
                    eyebrow="홈 화면에 설치하는 PWA"
                    title="모바일 앱"
                    action={
                        <Button
                            className="w-full"
                            variant="outline"
                            onClick={() => scrollToGuide('mobile-install')}
                        >
                            휴대폰 설치 방법 보기
                            <Download aria-hidden="true" />
                        </Button>
                    }
                >
                    <MobileNotificationMockup />
                </DeviceCard>
            </section>

            <section
                id="pc-install"
                className="scroll-mt-5 rounded-xl border bg-card p-5 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6"
                aria-labelledby="pc-install-title"
            >
                <div className="min-w-0">
                    <p className="text-xs font-semibold text-primary">PC 앱 설치</p>
                    <h2 id="pc-install-title" className="mt-1 text-xl font-bold tracking-tight">
                        Windows 또는 macOS에 설치
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        운영체제에 맞는 최신 설치 파일을 내려받고 Jungle Campus에 로그인합니다.
                    </p>
                </div>
                <Button asChild className="mt-4 w-full shrink-0 sm:mt-0 sm:w-auto">
                    <a href={PC_INSTALL_GUIDE_URL} target="_blank" rel="noopener noreferrer">
                        PC 앱 설치 가이드
                        <ExternalLink aria-hidden="true" />
                    </a>
                </Button>
            </section>

            <section
                id="mobile-install"
                className="scroll-mt-5 rounded-xl border bg-card p-5 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6"
                aria-labelledby="mobile-install-title"
            >
                <div className="min-w-0">
                    <p className="text-xs font-semibold text-primary">모바일 앱 설치</p>
                    <h2 id="mobile-install-title" className="mt-1 text-xl font-bold tracking-tight">
                        브라우저에서 홈 화면에 추가
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        iPhone은 공유 메뉴의 ‘홈 화면에 추가’, Android는 브라우저 메뉴의 ‘앱 설치’를
                        선택합니다.
                    </p>
                    <MobileInstallHandoffNotice status={mobileHandoffStatus} />
                </div>
                <MobileInstallAction
                    status={mobileHandoffStatus}
                    onRequestMobileInstall={onRequestMobileInstall}
                    onRetryMobileHandoff={onRetryMobileHandoff}
                />
            </section>
        </div>
    );
}

export default AppInstallPage;
