import {Link} from '@tanstack/react-router';
import {ExternalLink as ExternalLinkIcon} from 'lucide-react';

import {ExternalLink} from '@/components/ui/external-link';

const PROJECT_URL = 'https://github.com/YangSiJun528/jungle-bell';
const FEEDBACK_URL = `${PROJECT_URL}/issues/new/choose`;
const RELEASE_URL = `${PROJECT_URL}/releases/latest`;

function ExternalFooterLink({href, children}: {href: string; children: string}) {
    return (
        <ExternalLink
            href={href}
            className="inline-flex min-h-(--hit-area-min) items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            {children}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </ExternalLink>
    );
}

export function DashboardFooter() {
    return (
        <footer className="mx-auto mt-auto w-full max-w-6xl pt-12 pr-[max(var(--dashboard-inline-gutter),var(--safe-area-right))] pb-[calc(var(--dashboard-mobile-navigation-height)+var(--safe-area-bottom)+1rem)] pl-[max(var(--dashboard-inline-gutter),var(--safe-area-left))] lg:pb-8">
            <div className="border-t pt-6 text-sm text-muted-foreground">
                <nav className="flex flex-wrap gap-x-5 gap-y-3" aria-label="프로젝트 정보">
                    <ExternalFooterLink href={PROJECT_URL}>GitHub</ExternalFooterLink>
                    <ExternalFooterLink href={FEEDBACK_URL}>피드백 남기기</ExternalFooterLink>
                    <ExternalFooterLink href={RELEASE_URL}>릴리즈</ExternalFooterLink>
                    <Link
                        to="/privacy"
                        className="inline-flex min-h-(--hit-area-min) items-center rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        개인정보 처리방침
                    </Link>
                </nav>
            </div>
        </footer>
    );
}
