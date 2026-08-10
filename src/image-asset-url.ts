export function isSafeImageAssetUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const isLocalHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
        return !url.username
            && !url.password
            && (url.protocol === 'https:' || isLocalHttp)
            && url.pathname.startsWith('/api/public/assets/');
    } catch {
        return false;
    }
}
