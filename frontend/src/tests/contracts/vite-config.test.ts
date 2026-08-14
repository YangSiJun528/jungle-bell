import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';
import {resolveConfig, type ProxyOptions, type ResolvedConfig} from 'vite';
import {
    buildApiOrigin,
    bypassDevApiModuleRequest,
    defaultDevApiOrigin,
    type FrontendTarget,
    normalizeDevApiOrigin,
    tauriDevOrigin,
} from '../../../vite.config';

const configFile = fileURLToPath(new URL('../../../vite.config.ts', import.meta.url));

async function interpretedConfig(
    command: 'serve' | 'build',
    target: FrontendTarget = 'web',
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
            target,
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

test('웹 개발 Vite 설정은 API proxy와 web build target을 사용한다', async () => {
    const config = await interpretedConfig('serve');
    const proxy = apiProxy(config);

    assert.equal(config.define?.['__JUNGLE_BELL_TARGET__'], JSON.stringify('web'));
    assert.equal(config.define?.['import.meta.env.VITE_PLATFORM_API_URL'], undefined);
    assert.equal(proxy.target, defaultDevApiOrigin);
    assert.equal(proxy.changeOrigin, true);
    assert.equal(proxy.secure, true);
    assert.deepEqual(proxy.headers, {origin: defaultDevApiOrigin});
    assert.equal(config.cacheDir, resolve(import.meta.dirname, '../../../node_modules/.vite'));
});

test('웹 production 빌드는 same-origin API와 전용 산출물 경로를 사용한다', async () => {
    const config = await interpretedConfig('build');

    assert.equal(config.define?.['__JUNGLE_BELL_TARGET__'], JSON.stringify('web'));
    assert.equal(config.define?.['import.meta.env.VITE_PLATFORM_API_URL'], undefined);
    assert.equal(config.build.outDir, 'dist/web');
});

test('desktop build만 허용된 원격 API origin을 주입한다', () => {
    assert.equal(buildApiOrigin('build', 'web', {}), null);
    assert.equal(buildApiOrigin('serve', 'desktop', {
        JUNGLE_BELL_DEV_API_ORIGIN: 'https://api.example.com',
        JUNGLE_BELL_DATA_API_URL: 'https://api.example.com',
    }), 'https://api.example.com');
    assert.equal(buildApiOrigin('build', 'desktop', {
        JUNGLE_BELL_DATA_API_URL: `${defaultDevApiOrigin}/`,
    }), defaultDevApiOrigin);
    assert.throws(
        () => buildApiOrigin('build', 'desktop', {
            JUNGLE_BELL_DATA_API_URL: 'http://127.0.0.1:8787',
        }),
        /JUNGLE_BELL_DATA_API_URL_INVALID/,
    );
    assert.throws(
        () => buildApiOrigin('build', 'desktop', {
            JUNGLE_BELL_DATA_API_URL: 'https://api.example.com',
        }),
        /JUNGLE_BELL_DATA_API_URL_INVALID/,
    );
});

test('해석된 Tauri production config는 public/private origin을 함께 고정한다', async () => {
    const config = await interpretedConfig('build', 'desktop', {
        JUNGLE_BELL_DATA_API_URL: defaultDevApiOrigin,
    });
    assert.equal(
        config.define?.['import.meta.env.VITE_PLATFORM_API_URL'],
        JSON.stringify(defaultDevApiOrigin),
    );
});

test('Spring과 Tauri production build는 같은 React target과 분리된 API 설정을 사용한다', async () => {
    const spring = await interpretedConfig('build');
    const tauri = await interpretedConfig('build', 'desktop', {
        JUNGLE_BELL_DATA_API_URL: defaultDevApiOrigin,
    });

    assert.equal(spring.build.target, 'safari13');
    assert.equal(tauri.build.target, spring.build.target);
    assert.equal(spring.define?.['__JUNGLE_BELL_TARGET__'], JSON.stringify('web'));
    assert.equal(tauri.define?.['__JUNGLE_BELL_TARGET__'], JSON.stringify('desktop'));
    assert.equal(spring.define?.['import.meta.env.VITE_PLATFORM_API_URL'], undefined);
    assert.equal(
        tauri.define?.['import.meta.env.VITE_PLATFORM_API_URL'],
        JSON.stringify(defaultDevApiOrigin),
    );
});

test('account API 개발 proxy는 브라우저 Origin을 보존한다', async () => {
    const config = await interpretedConfig('serve');
    const proxy = config.server.proxy?.['/api/me'];
    assert.ok(proxy && typeof proxy !== 'string');
    assert.equal(proxy.target, defaultDevApiOrigin);
    assert.equal(proxy.headers, undefined);
});

test('Tauri dev account proxy는 GET에도 exact WebView Origin을 보낸다', () => {
    assert.equal(tauriDevOrigin('web'), null);
    assert.equal(tauriDevOrigin('desktop'), 'http://127.0.0.1:5173');
});

test('해석된 Tauri dev proxy에도 exact WebView Origin header가 설정된다', async () => {
    const config = await interpretedConfig('serve', 'desktop');
    const proxy = config.server.proxy?.['/api/me'];
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
