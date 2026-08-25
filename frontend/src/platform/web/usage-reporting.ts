type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type UsageRetryDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

interface VisibilityDocument {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface UsageReportOptions {
    signal?: AbortSignal;
    delay?: UsageRetryDelay;
}

const RETRY_DELAYS_MS = [250, 1_000] as const;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function defaultRetryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();

    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timeoutId = setTimeout(finish, milliseconds);
        signal?.addEventListener('abort', finish, {once: true});
    });
}

function requestOptions(signal?: AbortSignal): RequestInit {
    return {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal,
    };
}

async function requestWithRetry(
    path: string,
    init: RequestInit,
    fetcher: UsageFetch,
    canAttempt: () => boolean,
    options: UsageReportOptions,
): Promise<Response | undefined> {
    const delay = options.delay ?? defaultRetryDelay;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (options.signal?.aborted || !canAttempt()) return undefined;

        let response: Response;
        try {
            response = await fetcher(path, init);
        } catch {
            if (options.signal?.aborted || !canAttempt()) return undefined;
            const retryDelay = RETRY_DELAYS_MS[attempt];
            if (retryDelay === undefined) return undefined;
            await delay(retryDelay, options.signal);
            continue;
        }

        if (!RETRYABLE_STATUSES.has(response.status)) return response;
        if (options.signal?.aborted || !canAttempt()) return response;
        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) return response;

        await delay(retryDelay, options.signal);
    }

    return undefined;
}

export async function reportWebUiOpened(
    installedPwa: boolean,
    fetcher: UsageFetch,
    allowsAnonymousReporting: () => boolean = () => true,
    options: UsageReportOptions = {},
): Promise<void> {
    try {
        const canContinue = () => !options.signal?.aborted;
        if (installedPwa) {
            const authenticated = await requestWithRetry(
                '/api/me/usage/ui-opened',
                requestOptions(options.signal),
                fetcher,
                canContinue,
                options,
            );
            if (authenticated?.status !== 401) return;
        }

        if (!allowsAnonymousReporting()) return;
        await requestWithRetry(
            '/api/public/usage/ui-opened',
            {
                ...requestOptions(options.signal),
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({client: installedPwa ? 'pwa' : 'web'}),
            },
            fetcher,
            () => canContinue() && allowsAnonymousReporting(),
            options,
        );
    } catch {
        // 사용 통계는 화면과 업무 기능의 성공 여부에 영향을 주지 않는다.
    }
}

export function startWebUsageReporting(options: {
    installedPwa: boolean;
    enabled?: boolean;
    fetcher?: UsageFetch;
    documentObject?: VisibilityDocument;
    allowsAnonymousReporting?: () => boolean;
    delay?: UsageRetryDelay;
}): () => void {
    if (options.enabled === false) return () => undefined;

    const fetcher = options.fetcher ?? window.fetch.bind(window);
    const documentObject = options.documentObject ?? document;
    let stopped = false;
    let inFlight = false;
    let reportAfterFlight = false;
    let abortController: AbortController | null = null;

    const reportVisible = () => {
        if (stopped) return;
        if (documentObject.visibilityState !== 'visible') {
            reportAfterFlight = false;
            abortController?.abort();
            return;
        }
        if (inFlight) {
            if (abortController?.signal.aborted) reportAfterFlight = true;
            return;
        }

        inFlight = true;
        reportAfterFlight = false;
        const currentAbortController = new AbortController();
        abortController = currentAbortController;
        void reportWebUiOpened(options.installedPwa, fetcher, options.allowsAnonymousReporting, {
            signal: currentAbortController.signal,
            delay: options.delay,
        }).finally(() => {
            if (abortController === currentAbortController) abortController = null;
            inFlight = false;
            if (!stopped && reportAfterFlight && documentObject.visibilityState === 'visible') {
                reportVisible();
            }
        });
    };

    documentObject.addEventListener('visibilitychange', reportVisible);
    reportVisible();
    return () => {
        stopped = true;
        reportAfterFlight = false;
        abortController?.abort();
        documentObject.removeEventListener('visibilitychange', reportVisible);
    };
}
