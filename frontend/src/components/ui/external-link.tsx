import {
    createContext,
    useContext,
    type ComponentProps,
    type MouseEventHandler,
    type PropsWithChildren,
    type ReactElement,
} from 'react';

import {normalizeExternalUrl} from '@/lib/external-link-policy';

import {openExternalLinkFromClick, type ExternalUrlOpener} from './external-link-click';

export type {ExternalUrlOpener} from './external-link-click';

interface ExternalLinkRuntime {
    openExternally?: ExternalUrlOpener;
    onOpenError?: (error: unknown) => void;
}

const ExternalLinkRuntimeContext = createContext<ExternalLinkRuntime | null>(null);

export function ExternalLinkRuntimeProvider({
    children,
    value,
}: PropsWithChildren<{value: ExternalLinkRuntime}>) {
    return (
        <ExternalLinkRuntimeContext.Provider value={value}>
            {children}
        </ExternalLinkRuntimeContext.Provider>
    );
}

export interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target' | 'rel'> {
    href: string;
    openExternally?: ExternalUrlOpener;
    onOpenError?: (error: unknown) => void;
}

export function ExternalLink({
    href,
    openExternally,
    onOpenError,
    onClick,
    children,
    ...props
}: ExternalLinkProps): ReactElement<ComponentProps<'a'>> {
    const runtime = useContext(ExternalLinkRuntimeContext);
    const safeHref = normalizeExternalUrl(href);
    const opener = openExternally ?? runtime?.openExternally;
    const handleClick: MouseEventHandler<HTMLAnchorElement> = async (event) => {
        onClick?.(event);
        await openExternalLinkFromClick(event, safeHref, opener, (error) => {
            onOpenError?.(error);
            runtime?.onOpenError?.(error);
        });
    };

    return (
        <a
            {...props}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleClick}
        >
            {children}
        </a>
    );
}
