import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, transformWithOxc, type Plugin} from 'vite';

const require = createRequire(import.meta.url);
const {VitePWA} = require('vite-plugin-pwa') as {
    VitePWA: (options: Record<string, unknown>) => Plugin[];
};

export type FrontendTarget = 'web' | 'desktop';

const host = process.env.TAURI_DEV_HOST;
export const defaultDevApiOrigin = 'https://jungle-bell.sijun-yang.com';
export const tauriApiOrigins = new Set([defaultDevApiOrigin]);

export function frontendTarget(mode: string): FrontendTarget {
    if (mode === 'desktop') return 'desktop';
    if (mode === 'web' || mode === 'test') return 'web';
    throw new Error('FRONTEND_TARGET_INVALID');
}

export function normalizeDevApiOrigin(value: string): string {
    const parsed = new URL(value);
    const localHttp = parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if ((parsed.protocol !== 'https:' && !localHttp)
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash) {
        throw new Error('JUNGLE_BELL_DEV_API_ORIGIN_INVALID');
    }
    return parsed.origin;
}

export function buildApiOrigin(
    command: 'serve' | 'build',
    target: FrontendTarget,
    environment: Record<string, string | undefined>,
): string | null {
    if (target === 'web') return null;
    const value = environment.JUNGLE_BELL_DATA_API_URL;
    if (!value?.trim()) throw new Error('JUNGLE_BELL_DATA_API_URL_REQUIRED');
    const origin = normalizeDevApiOrigin(value);
    if (command === 'build' && !tauriApiOrigins.has(origin)) {
        throw new Error('JUNGLE_BELL_DATA_API_URL_INVALID');
    }
    return origin;
}

export function bypassDevApiModuleRequest(url: string | undefined): string | undefined {
    if (url && /^\/api\/[^/]+\.[cm]?[jt]sx?(?:\?|$)/u.test(url)) return url;
    return undefined;
}

export function tauriDevOrigin(target: FrontendTarget): string | null {
    return target === 'desktop' ? 'http://127.0.0.1:5173' : null;
}

function injectionScriptPlugin(outDir: string): Plugin {
    const source = resolve(import.meta.dirname, 'src/platform/tauri/checker/checker.ts');
    const output = resolve(import.meta.dirname, outDir, 'injected/checker.js');

    const compile = async () => {
        const result = await transformWithOxc(readFileSync(source, 'utf8'), source, {
            lang: 'ts',
            sourceType: 'script',
            target: 'safari13',
            sourcemap: false,
        });
        const compiled = `(function () {\n${result.code}\n})();\n`;
        mkdirSync(resolve(output, '..'), {recursive: true});
        let previous: string | null = null;
        try {
            previous = readFileSync(output, 'utf8');
        } catch {
            // The first build has no generated checker script yet.
        }
        if (previous !== compiled) writeFileSync(output, compiled);
    };

    return {
        name: 'desktop-checker-script',
        async buildStart() {
            this.addWatchFile(source);
            await compile();
        },
        writeBundle: compile,
        async handleHotUpdate(context) {
            if (context.file === source) await compile();
        },
    };
}

function pwaHtmlPlugin(): Plugin {
    const tags = [
        '<meta name="apple-mobile-web-app-capable" content="yes"/>',
        '<meta name="apple-mobile-web-app-status-bar-style" content="default"/>',
        '<meta name="apple-mobile-web-app-title" content="Jungle Bell"/>',
        '<link rel="manifest" href="./manifest.webmanifest"/>',
        '<link rel="apple-touch-icon" href="./icons/icon-192.png"/>',
    ].join('\n    ');
    return {
        name: 'web-pwa-html',
        transformIndexHtml: {
            order: 'pre',
            handler: (html) => html.replace('</head>', `    ${tags}\n</head>`),
        },
    };
}

export default defineConfig(({command, mode}) => {
    const target = frontendTarget(mode);
    const outDir = `dist/${target}`;
    const platformApiOrigin = buildApiOrigin(command, target, process.env);
    const devApiOrigin = command === 'serve'
        ? target === 'desktop'
            ? platformApiOrigin as string
            : normalizeDevApiOrigin(
                process.env.JUNGLE_BELL_DEV_API_ORIGIN ?? defaultDevApiOrigin,
            )
        : null;
    const developmentTauriOrigin = command === 'serve' ? tauriDevOrigin(target) : null;
    const define: Record<string, string> = {
        __JUNGLE_BELL_TARGET__: JSON.stringify(target),
        __JUNGLE_BELL_BUILD_CONFIG__: JSON.stringify(target === 'desktop'
            ? {target, platformApiUrl: platformApiOrigin as string}
            : {target, platformApiUrl: null}),
    };

    return {
        plugins: [
            react(),
            tailwindcss(),
            ...(target === 'desktop'
                ? [injectionScriptPlugin(outDir)]
                : [
                    pwaHtmlPlugin(),
                    ...VitePWA({
                        strategies: 'injectManifest',
                        srcDir: 'src/platform/pwa/service-worker',
                        filename: 'sw.js',
                        injectRegister: false,
                        registerType: 'prompt',
                        manifest: false,
                        injectManifest: {
                            rollupFormat: 'iife',
                            globPatterns: [
                                'index.html',
                                'manifest.webmanifest',
                                'icons/**/*.{png,svg,ico}',
                                'assets/**/*.{js,css,png,woff2,txt}',
                            ],
                        },
                        devOptions: {enabled: false},
                    }),
                ]),
        ],
        resolve: {
            alias: {
                '@': resolve(import.meta.dirname, 'src'),
            },
        },
        cacheDir: 'node_modules/.vite',
        base: './',
        clearScreen: false,
        publicDir: target === 'web'
            ? resolve(import.meta.dirname, 'src/platform/pwa/public')
            : false,
        define,
        server: command === 'serve' ? {
            host: host ?? '127.0.0.1',
            port: 5173,
            strictPort: true,
            proxy: {
                '/api/me': {
                    target: devApiOrigin as string,
                    changeOrigin: true,
                    secure: true,
                    ...(developmentTauriOrigin ? {headers: {origin: developmentTauriOrigin}} : {}),
                },
                '/api': {
                    target: devApiOrigin as string,
                    changeOrigin: true,
                    secure: true,
                    headers: {origin: devApiOrigin as string},
                    bypass: (request) => bypassDevApiModuleRequest(request.url),
                },
            },
        } : undefined,
        // Tauri signing variables are consumed by Node-side configuration only.
        envPrefix: ['VITE_'],
        build: {
            target: 'safari13',
            outDir,
            emptyOutDir: true,
            sourcemap: target === 'desktop' && process.env.TAURI_ENV_DEBUG === 'true',
            minify: target === 'desktop' && process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
        },
    };
});
