import {CircleAlert, X} from 'lucide-react';
import {useMemo, useState, type PropsWithChildren} from 'react';

import {Button} from '@/components/ui/button';
import {ExternalLinkRuntimeProvider} from '@/components/ui/external-link';
import type {PlatformAdapter} from '@/platform/contracts';

import {desktopExternalOpener} from './external-link-runtime';

export function DashboardExternalLinkController({
    children,
    platform,
}: PropsWithChildren<{platform: PlatformAdapter}>) {
    const [failed, setFailed] = useState(false);
    const openExternally = useMemo(() => desktopExternalOpener(platform), [platform]);
    const runtime = useMemo(
        () => ({
            openExternally,
            onOpenError: () => setFailed(true),
        }),
        [openExternally],
    );

    return (
        <ExternalLinkRuntimeProvider value={runtime}>
            {children}
            {failed ? (
                <div
                    className="fixed top-[max(0.75rem,var(--safe-area-top))] right-[max(0.75rem,var(--safe-area-right))] left-[max(0.75rem,var(--safe-area-left))] z-[120] ml-auto flex max-w-md items-start gap-3 rounded-lg border border-destructive/40 bg-background p-4 text-base leading-6 shadow-xl sm:left-auto"
                    role="alert"
                    data-external-link-error="true"
                >
                    <CircleAlert
                        aria-hidden="true"
                        className="mt-0.5 size-5 shrink-0 text-destructive"
                    />
                    <p className="min-w-0 flex-1">
                        시스템 브라우저에서 링크를 열지 못했습니다. 잠시 뒤 다시 시도하세요.
                    </p>
                    <Button
                        aria-label="외부 링크 오류 닫기"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setFailed(false)}
                    >
                        <X aria-hidden="true" />
                    </Button>
                </div>
            ) : null}
        </ExternalLinkRuntimeProvider>
    );
}
