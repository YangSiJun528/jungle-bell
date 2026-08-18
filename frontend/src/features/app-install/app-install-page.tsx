import {Link} from '@tanstack/react-router';
import {
    ArrowLeft,
    Download,
    Monitor,
    Settings,
    Smartphone,
    type LucideIcon,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {DesktopAppMockup} from '@/components/app-showcase/desktop-app-mockup';
import {MobileNotificationMockup} from '@/components/app-showcase/mobile-notification-mockup';
import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';

const RELEASE_URL = 'https://github.com/YangSiJun528/jungle-bell/releases/latest';
const WEB_APP_URL = 'https://jungle-bell.sijun-yang.com';

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
                    <Icon aria-hidden="true" className="size-5"/>
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-primary">{eyebrow}</p>
                    <h3 className="text-xl font-bold tracking-tight">{title}</h3>
                </div>
                {badge ? <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">{badge}</span> : null}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4 px-5 pb-5 sm:px-6 sm:pb-6">
                {children}
                <div className="mt-auto">{action}</div>
            </CardContent>
        </Card>
    );
}

export function AppInstallPage({onRequestMobileInstall}: {
    onRequestMobileInstall?: () => void;
}) {
    return (
        <div className="space-y-8">
            <PageHeader
                title="앱 설치 안내"
                actions={(
                    <Button asChild variant="outline">
                        <Link to="/home"><ArrowLeft aria-hidden="true"/>대시보드로 돌아가기</Link>
                    </Button>
                )}
            />

            <section className="mx-auto max-w-4xl py-3 text-center" aria-labelledby="install-hero-title">
                <h2 id="install-hero-title" className="text-balance text-3xl font-bold leading-tight tracking-[-0.045em] sm:text-5xl">
                    PC·모바일 앱으로 Jungle Bell을 <span className="text-primary">더 편리하게 사용하세요.</span>
                </h2>
                <p className="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
                    데스크톱에서는 출석 상태를 자동으로 확인하고, 모바일에서는 출석·세탁·식사 생활 알림을 잠금 화면에서 받아볼 수 있어요.
                </p>
            </section>

            <section className="grid min-w-0 gap-4 lg:grid-cols-2" aria-label="기기별 Jungle Bell 앱 안내">
                <DeviceCard
                    icon={Monitor}
                    eyebrow="출석 상태 확인"
                    title="PC 앱"
                    badge="필수"
                    emphasized
                    action={(
                        <Button className="w-full" onClick={() => scrollToGuide('pc-install')}>
                            내 PC 설치 방법 보기<Download aria-hidden="true"/>
                        </Button>
                    )}
                >
                    <DesktopAppMockup/>
                </DeviceCard>

                <DeviceCard
                    icon={Smartphone}
                    eyebrow="홈 화면에 설치하는 PWA"
                    title="모바일 앱"
                    action={(
                        <Button className="w-full" variant="outline" onClick={() => scrollToGuide('mobile-install')}>
                            휴대폰 설치 방법 보기<Download aria-hidden="true"/>
                        </Button>
                    )}
                >
                    <MobileNotificationMockup/>
                </DeviceCard>
            </section>

            <section
                id="pc-install"
                className="scroll-mt-5 rounded-xl border bg-card p-5 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-6 sm:p-6"
                aria-labelledby="pc-install-title"
            >
                <div className="min-w-0">
                    <p className="text-xs font-semibold text-primary">PC 앱 설치</p>
                    <h2 id="pc-install-title" className="mt-1 text-xl font-bold tracking-tight">Windows 또는 macOS에 설치</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        운영체제에 맞는 최신 설치 파일을 내려받고 Jungle Campus에 로그인합니다.
                    </p>
                </div>
                <Button asChild className="mt-4 w-full shrink-0 sm:mt-0 sm:w-auto">
                    <a href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
                        최신 PC 앱 다운로드<Download aria-hidden="true"/>
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
                    <h2 id="mobile-install-title" className="mt-1 text-xl font-bold tracking-tight">브라우저에서 홈 화면에 추가</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        iPhone은 공유 메뉴의 ‘홈 화면에 추가’, Android는 브라우저 메뉴의 ‘앱 설치’를 선택합니다.
                    </p>
                </div>
                {onRequestMobileInstall ? (
                    <Button className="mt-4 w-full shrink-0 sm:mt-0 sm:w-auto" variant="outline" onClick={onRequestMobileInstall}>
                        모바일 앱 설치 안내 열기<Smartphone aria-hidden="true"/>
                    </Button>
                ) : (
                    <Button asChild className="mt-4 w-full shrink-0 sm:mt-0 sm:w-auto" variant="outline">
                        <a href={WEB_APP_URL} target="_blank" rel="noopener noreferrer">
                            모바일 앱 페이지 열기<Smartphone aria-hidden="true"/>
                        </a>
                    </Button>
                )}
            </section>

            <aside className="flex flex-col gap-4 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center sm:p-6" aria-labelledby="installed-title">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm">
                    <Settings aria-hidden="true" className="size-5"/>
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id="installed-title" className="font-semibold">이미 앱을 설치했나요?</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        설치를 다시 할 필요 없이 설정에서 기기 연결을 시작할 수 있습니다.
                    </p>
                </div>
                <Button asChild variant="outline" className="w-full shrink-0 bg-card sm:w-auto">
                    <Link to="/connections">설정으로 이동</Link>
                </Button>
            </aside>
        </div>
    );
}

export default AppInstallPage;
