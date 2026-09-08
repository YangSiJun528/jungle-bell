import type {ExternalUrlOpener} from '@/components/ui/external-link';
import type {PlatformAdapter} from '@/platform/contracts';

function hasExternalLinkOpener(value: unknown): value is {open: ExternalUrlOpener} {
    return (
        typeof value === 'object' &&
        value !== null &&
        'open' in value &&
        typeof value.open === 'function'
    );
}

export function desktopExternalOpener(platform: PlatformAdapter): ExternalUrlOpener | undefined {
    if (platform.kind !== 'desktop' || !('externalLinks' in platform)) return undefined;
    const externalLinks = platform.externalLinks;
    return hasExternalLinkOpener(externalLinks) ? (url) => externalLinks.open(url) : undefined;
}
