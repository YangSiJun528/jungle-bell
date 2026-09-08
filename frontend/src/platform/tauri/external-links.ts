import {invoke as tauriInvoke} from '@tauri-apps/api/core';

import {normalizeExternalUrl} from '@/components/ui/external-link-policy';
import type {NativeInvoke} from '@/platform/contracts';

export {normalizeExternalUrl} from '@/components/ui/external-link-policy';

export interface TauriExternalLinkAdapter {
    open(url: string): Promise<void>;
}

export function createTauriExternalLinkAdapter(
    invokeCommand: NativeInvoke = (command, args) => tauriInvoke(command, args),
): TauriExternalLinkAdapter {
    return {
        async open(value) {
            const url = normalizeExternalUrl(value);
            await invokeCommand('plugin:opener|open_url', {url});
        },
    };
}
