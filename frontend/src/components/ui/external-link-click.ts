import type {ExternalUrlOpener} from './external-link';

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
