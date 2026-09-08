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
            className="relative min-w-0 gap-0 overflow-hidden border-primary/15 py-0 shadow-[0_12px_32px_rgba(46,77,51,.07)]"
            data-app-showcase-card="true"
            aria-labelledby="home-install-promotion-title"
        >
            <div className="flex min-w-0 flex-col gap-4 p-4 pr-14 sm:flex-row sm:items-center sm:px-5 sm:py-4 lg:pr-52">
                <div className="min-w-0 flex-1">
                    <h2
                        id="home-install-promotion-title"
                        className="text-lg leading-6 font-bold tracking-[-0.025em] whitespace-normal sm:whitespace-nowrap"
                    >
                        PC·PWA를 설치해
                        <br />
                        <span className="text-primary">더 편리하게 사용하세요.</span>
                    </h2>
                    <p className="mt-1.5 text-base leading-6 text-pretty text-muted-foreground">
                        출석 상태를 확인하고, 출석·식사·세탁 생활 알림과 앞으로 추가될 편의 기능까지
                        이용할 수 있어요.
                    </p>
                </div>

                <Button
                    asChild
                    className="h-auto min-h-11 w-full min-w-0 px-4 py-2 whitespace-normal sm:w-auto"
                >
                    <Link to="/install">
                        앱 안내 보기
                        <ArrowRight aria-hidden="true" />
                    </Link>
                </Button>
            </div>

            <div
                className="pointer-events-none absolute top-3 right-4 hidden h-24 w-40 gap-2 lg:flex"
                aria-hidden="true"
            >
                <DesktopAppMockup
                    compact
                    className="h-24 min-h-24 w-24 flex-1 rounded-lg shadow-none"
                />
                <MobileNotificationMockup
                    phone
                    className="h-24 min-h-24 w-12 rounded-lg border-2 shadow-none"
                />
            </div>

            <Button
                size="icon"
                variant="ghost"
                className="absolute top-1.5 right-1.5 size-11"
                aria-label="설치 안내 닫기"
                onClick={dismiss}
            >
                <X aria-hidden="true" className="size-4" />
            </Button>
        </Card>
    );
}
