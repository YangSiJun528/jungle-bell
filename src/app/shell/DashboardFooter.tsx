import {ExternalLink} from 'lucide-react';

const PROJECT_URL = 'https://github.com/YangSiJun528/jungle-bell';
const FEEDBACK_URL = `${PROJECT_URL}/discussions/categories/건의하기`;
const RELEASE_URL = `${PROJECT_URL}/releases/latest`;

function ExternalFooterLink({href, children}: {href: string; children: string}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {children}
            <ExternalLink className="size-3.5" aria-hidden="true"/>
        </a>
    );
}

export function DashboardFooter() {
    return (
        <footer className="mx-auto mt-auto w-full max-w-[90rem] px-3 pb-28 pt-12 sm:px-4 md:px-5 md:pb-8 lg:px-6">
            <div className="border-t pt-6 text-sm text-muted-foreground">
                <nav className="flex flex-wrap gap-x-5 gap-y-3" aria-label="프로젝트 정보">
                    <ExternalFooterLink href={PROJECT_URL}>GitHub</ExternalFooterLink>
                    <ExternalFooterLink href={FEEDBACK_URL}>피드백 남기기</ExternalFooterLink>
                    <ExternalFooterLink href={RELEASE_URL}>릴리즈</ExternalFooterLink>
                    <a
                        href="./blog/index.html"
                        className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        블로그 보기
                    </a>
                </nav>
            </div>
        </footer>
    );
}
