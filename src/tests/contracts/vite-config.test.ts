import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';
import {resolveConfig, type ProxyOptions, type ResolvedConfig} from 'vite';
import {
    defaultDevApiOrigin,
    normalizeDevApiOrigin,
} from '../../../vite.config';

const configFile = fileURLToPath(new URL('../../../vite.config.ts', import.meta.url));

async function interpretedConfig(command: 'serve' | 'build'): Promise<ResolvedConfig> {
    const previous = process.env.JUNGLE_BELL_DEV_API_ORIGIN;
    delete process.env.JUNGLE_BELL_DEV_API_ORIGIN;
    try {
        return await resolveConfig(
            {configFile},
            command,
            command === 'serve' ? 'development' : 'production',
        );
    } finally {
        if (previous === undefined) delete process.env.JUNGLE_BELL_DEV_API_ORIGIN;
        else process.env.JUNGLE_BELL_DEV_API_ORIGIN = previous;
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
