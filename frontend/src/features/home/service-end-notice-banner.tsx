import {ArrowUpRight} from 'lucide-react';

export function ServiceEndNoticeBanner() {
    return (
        <a
            href="https://github.com/YangSiJun528/jungle-bell/blob/main/SERVICE_END_NOTICE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4 text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-6 sm:py-5"
        >
            <div className="min-w-0 space-y-1 break-keep">
                <h2 className="text-base leading-6 font-semibold">
                    Jungle Bell 운영 종료 예정 안내
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                    서버는 2026년 10월 16일까지 운영할 예정이며, 이후에는 별도 예고 없이 종료될 수
                    있습니다.
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
