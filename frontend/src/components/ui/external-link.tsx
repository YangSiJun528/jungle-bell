import type {ComponentProps, MouseEventHandler, ReactElement} from 'react';

import {normalizeExternalUrl} from './external-link-policy';

export type ExternalUrlOpener = (url: string) => Promise<void>;

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
    const safeHref = normalizeExternalUrl(href);
    const handleClick: MouseEventHandler<HTMLAnchorElement> = async (event) => {
        onClick?.(event);
        if (event.defaultPrevented || !openExternally) return;
        event.preventDefault();
        try {
            await openExternally(safeHref);
        } catch (error) {
            onOpenError?.(error);
        }
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
