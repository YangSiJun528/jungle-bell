type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface VisibilityDocument {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export async function reportWebUiOpened(
    installedPwa: boolean,
    fetcher: UsageFetch,
    allowsAnonymousReporting: () => boolean = () => true,
): Promise<void> {
    try {
        if (installedPwa) {
            const authenticated = await fetcher('/api/me/usage/ui-opened', {
                method: 'POST',
                credentials: 'include',
                redirect: 'error',
                cache: 'no-store',
            });
            if (authenticated.status !== 401) return;
        }
        if (!allowsAnonymousReporting()) return;
        await fetcher('/api/public/usage/ui-opened', {
            method: 'POST',
            credentials: 'include',
            redirect: 'error',
            cache: 'no-store',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({client: installedPwa ? 'pwa' : 'web'}),
        });
    } catch {
        // 사용 통계는 화면과 업무 기능의 성공 여부에 영향을 주지 않는다.
    }
}

export function startWebUsageReporting(options: {
    installedPwa: boolean;
    fetcher?: UsageFetch;
    documentObject?: VisibilityDocument;
    allowsAnonymousReporting?: () => boolean;
}): () => void {
    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const documentObject = options.documentObject ?? document;
    let inFlight = false;
    const reportVisible = () => {
        if (documentObject.visibilityState !== 'visible' || inFlight) return;
        inFlight = true;
        void reportWebUiOpened(
            options.installedPwa,
            fetcher,
            options.allowsAnonymousReporting,
        ).finally(() => {
            inFlight = false;
        });
    };
    documentObject.addEventListener('visibilitychange', reportVisible);
    reportVisible();
    return () => documentObject.removeEventListener('visibilitychange', reportVisible);
}
