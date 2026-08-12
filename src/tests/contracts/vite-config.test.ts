import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';
import {resolveConfig, type ProxyOptions, type ResolvedConfig} from 'vite';
import {
    bypassDevApiModuleRequest,
    defaultDevApiOrigin,
    normalizeDevApiOrigin,
    tauriBuildApiOrigin,
    tauriDevOrigin,
} from '../../../vite.config';

const configFile = fileURLToPath(new URL('../../../vite.config.ts', import.meta.url));

async function interpretedConfig(
    command: 'serve' | 'build',
    environment: Record<string, string | undefined> = {},
): Promise<ResolvedConfig> {
    const keys = [
        'JUNGLE_BELL_DEV_API_ORIGIN',
        'JUNGLE_BELL_DATA_API_URL',
        'TAURI_ENV_PLATFORM',
        'TAURI_DEV_HOST',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    delete process.env.JUNGLE_BELL_DEV_API_ORIGIN;
    delete process.env.JUNGLE_BELL_DATA_API_URL;
    delete process.env.TAURI_ENV_PLATFORM;
    delete process.env.TAURI_DEV_HOST;
    for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await resolveConfig(
            {configFile},
            command,
            command === 'serve' ? 'development' : 'production',
        );
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function apiProxy(config: ResolvedConfig): ProxyOptions {
    const proxy = config.server.proxy?.['/api'];
    assert.ok(proxy && typeof proxy !== 'string');
    return proxy;
}

test('개발 Vite 설정은 공개 API와 동일 origin 개인 API proxy를 분리한다', async () => {
    const config = await interpretedConfig('serve');
    const proxy = apiProxy(config);

    assert.equal(
        config.define?.['import.meta.env.VITE_CAMPUS_API_URL'],
        JSON.stringify(defaultDevApiOrigin),
    );
    assert.equal(
        config.define?.['import.meta.env.VITE_PLATFORM_API_URL'],
        JSON.stringify(''),
    );
    assert.equal(proxy.target, defaultDevApiOrigin);
    assert.equal(proxy.changeOrigin, true);
    assert.equal(proxy.secure, true);
    assert.deepEqual(proxy.headers, {origin: defaultDevApiOrigin});
    assert.equal(config.cacheDir, resolve(import.meta.dirname, '../../../node_modules/.vite'));
});

test('프로덕션 빌드는 개발 API origin을 브라우저 bundle에 주입하지 않는다', async () => {
    const config = await interpretedConfig('build');

    assert.equal(config.define?.['import.meta.env.VITE_CAMPUS_API_URL'], undefined);
    assert.equal(config.define?.['import.meta.env.VITE_PLATFORM_API_URL'], undefined);
});

test('Tauri production build만 명시적인 원격 API origin을 주입한다', () => {
    assert.equal(tauriBuildApiOrigin('build', {}), null);
    assert.equal(tauriBuildApiOrigin('serve', {
        TAURI_ENV_PLATFORM: 'darwin',
        JUNGLE_BELL_DATA_API_URL: 'https://api.example.com',
    }), null);
    assert.equal(tauriBuildApiOrigin('build', {
        TAURI_ENV_PLATFORM: 'darwin',
        JUNGLE_BELL_DATA_API_URL: 'https://jungle-bell-api.yangsijun5528.workers.dev/',
    }), 'https://jungle-bell-api.yangsijun5528.workers.dev');
    assert.throws(
        () => tauriBuildApiOrigin('build', {TAURI_ENV_PLATFORM: 'windows'}),
        /JUNGLE_BELL_DATA_API_URL_REQUIRED/,
    );
    assert.throws(
        () => tauriBuildApiOrigin('build', {
            TAURI_ENV_PLATFORM: 'darwin',
            JUNGLE_BELL_DATA_API_URL: 'http://127.0.0.1:8787',
        }),
        /JUNGLE_BELL_DATA_API_URL_INVALID/,
    );
    assert.throws(
        () => tauriBuildApiOrigin('build', {
            TAURI_ENV_PLATFORM: 'darwin',
            JUNGLE_BELL_DATA_API_URL: 'https://api.example.com',
        }),
        /JUNGLE_BELL_DATA_API_URL_INVALID/,
    );
});

test('해석된 Tauri production config는 public/private origin을 함께 고정한다', async () => {
    const config = await interpretedConfig('build', {
        TAURI_ENV_PLATFORM: 'darwin',
        JUNGLE_BELL_DATA_API_URL: 'https://jungle-bell-api.yangsijun5528.workers.dev',
    });
    assert.equal(
        config.define?.['import.meta.env.VITE_CAMPUS_API_URL'],
        JSON.stringify('https://jungle-bell-api.yangsijun5528.workers.dev'),
    );
    assert.equal(
        config.define?.['import.meta.env.VITE_PLATFORM_API_URL'],
        JSON.stringify('https://jungle-bell-api.yangsijun5528.workers.dev'),
    );
});

test('desktop-ui 개발 proxy는 WebView Origin을 보존한다', async () => {
    const config = await interpretedConfig('serve');
    const proxy = config.server.proxy?.['/api/desktop-ui'];
    assert.ok(proxy && typeof proxy !== 'string');
    assert.equal(proxy.target, defaultDevApiOrigin);
    assert.equal(proxy.headers, undefined);
});

test('Tauri dev desktop-ui proxy는 GET에도 exact WebView Origin을 보낸다', () => {
    assert.equal(tauriDevOrigin({}), null);
    assert.equal(
        tauriDevOrigin({TAURI_ENV_PLATFORM: 'darwin'}),
        'http://127.0.0.1:5173',
    );
    assert.equal(
        tauriDevOrigin({TAURI_ENV_PLATFORM: 'windows', TAURI_DEV_HOST: 'localhost'}),
        'http://127.0.0.1:5173',
    );
});

test('해석된 Tauri dev proxy에도 exact WebView Origin header가 설정된다', async () => {
    const config = await interpretedConfig('serve', {TAURI_ENV_PLATFORM: 'darwin'});
    const proxy = config.server.proxy?.['/api/desktop-ui'];
    assert.ok(proxy && typeof proxy !== 'string');
    assert.deepEqual(proxy.headers, {origin: 'http://127.0.0.1:5173'});
});

test('개발 API origin은 안전한 origin 형태만 허용한다', () => {
    assert.equal(
        normalizeDevApiOrigin('http://127.0.0.1:8787/'),
        'http://127.0.0.1:8787',
    );
    assert.equal(
        normalizeDevApiOrigin('https://api.example.com/'),
        'https://api.example.com',
    );

    for (const invalid of [
        'http://api.example.com',
        'https://user:secret@api.example.com',
        'https://api.example.com/private',
    ]) {
        assert.throws(
            () => normalizeDevApiOrigin(invalid),
            /JUNGLE_BELL_DEV_API_ORIGIN_INVALID/,
            invalid,
        );
    }
});

test('개발 API proxy는 src/api 모듈 요청을 Vite 변환기로 넘긴다', () => {
    assert.equal(
        bypassDevApiModuleRequest('/api/dashboard-api.ts'),
        '/api/dashboard-api.ts',
    );
    assert.equal(
        bypassDevApiModuleRequest('/api/desktop-settings.ts?import'),
        '/api/desktop-settings.ts?import',
    );
    assert.equal(bypassDevApiModuleRequest('/api/public/status'), undefined);
    assert.equal(bypassDevApiModuleRequest('/api/v2/files/example.ts'), undefined);
});
