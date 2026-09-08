const PROJECT_PATH = '/YangSiJun528/jungle-bell';
const INSTALL_GUIDE_FRAGMENT = '#%EC%84%A4%EC%B9%98';
const MEAL_ASSET_PATH = /^\/api\/public\/assets\/[a-f0-9]{64}\.(?:avif|gif|jpe?g|png|webp)$/u;
const MEAL_POST_PATH = /^\/_xhzNjn\/(?:posts|[1-9][0-9]*)$/u;

function isLocalMealAsset(url: URL): boolean {
    return (
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        MEAL_ASSET_PATH.test(url.pathname) &&
        url.search === '' &&
        url.hash === ''
    );
}

function containsControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

export function normalizeExternalUrl(value: string): string {
    if (
        value.length === 0 ||
        value.length > 2_048 ||
        value.trim() !== value ||
        containsControlCharacter(value)
    ) {
        throw new Error('EXTERNAL_URL_NOT_ALLOWED');
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('EXTERNAL_URL_NOT_ALLOWED');
    }
    const localMealAsset = isLocalMealAsset(url);
    if (
        (!localMealAsset && url.protocol !== 'https:') ||
        url.username !== '' ||
        url.password !== '' ||
        (!localMealAsset && url.port !== '') ||
        url.search !== ''
    ) {
        throw new Error('EXTERNAL_URL_NOT_ALLOWED');
    }

    const allowed =
        (url.hostname === 'github.com' &&
            ((url.pathname === PROJECT_PATH &&
                (url.hash === '' || url.hash === INSTALL_GUIDE_FRAGMENT)) ||
                ((url.pathname === `${PROJECT_PATH}/issues/new/choose` ||
                    url.pathname === `${PROJECT_PATH}/releases/latest`) &&
                    url.hash === ''))) ||
        (url.hostname === 'jungle-lms.krafton.com' &&
            url.pathname === '/check-in' &&
            url.hash === '') ||
        (url.hostname === 'pf.kakao.com' && MEAL_POST_PATH.test(url.pathname) && url.hash === '') ||
        localMealAsset ||
        (url.hostname === 'jungle-bell.sijun-yang.com' &&
            MEAL_ASSET_PATH.test(url.pathname) &&
            url.hash === '');
    if (!allowed) throw new Error('EXTERNAL_URL_NOT_ALLOWED');
    return url.toString();
}
