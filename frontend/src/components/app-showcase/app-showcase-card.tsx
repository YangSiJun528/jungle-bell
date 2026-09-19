import {Link} from '@tanstack/react-router';
import {ArrowRight, X} from 'lucide-react';
import {useState} from 'react';

import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';

import {
    appShowcaseDismissed,
    dismissAppShowcase,
    type InstallPromotionStorage,
} from './app-showcase-dismissal';
import {DesktopAppMockup} from './desktop-app-mockup';
import {MobileNotificationMockup} from './mobile-notification-mockup';

function currentSessionStorage(): InstallPromotionStorage | undefined {
    if (typeof window === 'undefined') return undefined;
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

export function AppShowcaseCard() {
    const [visible, setVisible] = useState(() => !appShowcaseDismissed(currentSessionStorage()));

    if (!visible) return null;

    const dismiss = () => {
        dismissAppShowcase(currentSessionStorage());
        setVisible(false);
    };

    return (
        <Card
            className="relative grid min-w-0 gap-0 overflow-hidden border-primary/15 py-0 shadow-[0_18px_48px_rgba(46,77,51,.08)] lg:grid-cols-[minmax(19rem,0.88fr)_minmax(28rem,1.12fr)]"
            data-app-showcase-card="true"
            aria-labelledby="home-install-promotion-title"
        >
            <div className="z-10 flex min-w-0 flex-col justify-center px-5 py-9 sm:px-8 sm:py-11 lg:px-10">
                <h2
                    id="home-install-promotion-title"
                    className="text-3xl leading-[1.17] font-bold tracking-[-0.045em] whitespace-normal sm:text-4xl sm:whitespace-nowrap lg:text-[clamp(1.5rem,calc(6.25vw_-_2.47rem),2.25rem)]"
                >
                    PC·모바일 앱을 설치해
                    <br />
                    <span className="text-primary">더 편리하게 사용하세요.</span>
                </h2>
                <p className="mt-5 max-w-xl text-sm leading-6 text-pretty text-muted-foreground sm:text-base sm:leading-7">
                    출석 상태를 확인하고, 출석·식사·세탁 생활 알림과 앞으로 추가될 편의 기능까지
                    이용할 수 있어요.
                </p>
                <Button asChild size="lg" className="mt-7 w-full sm:w-fit">
                    <Link to="/install">
                        앱 안내 보기
                        <ArrowRight aria-hidden="true" />
                    </Link>
                </Button>
            </div>

            <div className="relative min-h-[25rem] min-w-0 overflow-hidden bg-[#e6f0e3] sm:min-h-[29rem]">
                <DesktopAppMockup
                    compact
                    className="absolute top-12 left-[-6%] w-[78%] -rotate-[1.2deg] sm:left-[4%] sm:w-[70%]"
                />
                <MobileNotificationMockup
                    phone
                    className="absolute right-[-5%] bottom-[-2rem] w-[47%] rotate-[2deg] sm:right-[2%] sm:bottom-[-1rem] sm:w-[39%]"
                />
            </div>
            <Button
                size="icon"
                variant="ghost"
                className="absolute top-1.5 right-1.5 z-20 size-11"
                aria-label="설치 안내 닫기"
                onClick={dismiss}
            >
                <X aria-hidden="true" className="size-4" />
            </Button>
        </Card>
    );
}
