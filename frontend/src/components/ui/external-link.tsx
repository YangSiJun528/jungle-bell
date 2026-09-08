import {
    createContext,
    useContext,
    type ComponentProps,
    type MouseEventHandler,
    type PropsWithChildren,
    type ReactElement,
} from 'react';

import {normalizeExternalUrl} from './external-link-policy';

export type ExternalUrlOpener = (url: string) => Promise<void>;

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

export async function openExternalLinkFromClick(
    event: Pick<Event, 'defaultPrevented' | 'preventDefault'>,
    href: string,
    openExternally: ExternalUrlOpener | undefined,
    onOpenError: ((error: unknown) => void) | undefined,
): Promise<void> {
    if (event.defaultPrevented || !openExternally) return;
    event.preventDefault();
    try {
        await openExternally(href);
    } catch (error) {
        onOpenError?.(error);
    }
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
