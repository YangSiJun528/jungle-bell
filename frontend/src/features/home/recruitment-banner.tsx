import {ArrowUpRight} from 'lucide-react';

export function RecruitmentBanner() {
    return (
        <a
            href="https://github.com/YangSiJun528/jungle-bell/blob/main/HELP_WANTED.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4 text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-6 sm:py-5"
        >
            <div className="min-w-0 space-y-1 break-keep">
                <h2 className="text-base leading-6 font-semibold">
                    정글 생활 편의 서비스를 직접 만들고 운영할 분을 찾습니다
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                    40명 이상이 사용하는 Jungle Bell을 이어받거나, 정글 생활을 돕는 새로운 서비스를
                    시작해 보세요.
                </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 self-start text-sm leading-6 font-semibold text-primary sm:self-center">
                자세히 보기
                <ArrowUpRight aria-hidden="true" className="size-4" />
                <span className="sr-only">(새 탭에서 열림)</span>
            </span>
        </a>
    );
}
