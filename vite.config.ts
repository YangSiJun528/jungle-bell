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

const host = process.env.TAURI_DEV_HOST;
export const defaultDevApiOrigin = 'https://jungle-bell-api-test.yangsijun5528.workers.dev';
export const tauriApiOrigins = new Set([
    'https://jungle-bell-api.yangsijun5528.workers.dev',
    defaultDevApiOrigin,
]);

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

export function tauriBuildApiOrigin(
    command: 'serve' | 'build',
    environment: Record<string, string | undefined>,
): string | null {
    if (command !== 'build' || !environment.TAURI_ENV_PLATFORM) return null;
    const value = environment.JUNGLE_BELL_DATA_API_URL;
    if (!value) throw new Error('JUNGLE_BELL_DATA_API_URL_REQUIRED');
    const origin = normalizeDevApiOrigin(value);
    if (!tauriApiOrigins.has(origin)) throw new Error('JUNGLE_BELL_DATA_API_URL_INVALID');
    return origin;
}

export function bypassDevApiModuleRequest(url: string | undefined): string | undefined {
    if (url && /^\/api\/[^/]+\.[cm]?[jt]sx?(?:\?|$)/u.test(url)) return url;
    return undefined;
}

export function tauriDevOrigin(environment: Record<string, string | undefined>): string | null {
    if (!environment.TAURI_ENV_PLATFORM) return null;
    return 'http://127.0.0.1:5173';
}

interface InjectionScript {
    name: string;
    sources: string[];
    output: string;
}

const injectionScripts: InjectionScript[] = [
    {
        name: 'checker',
        sources: [resolve(import.meta.dirname, 'src/injected/checker.ts')],
        output: resolve(import.meta.dirname, 'dist/injected/checker.js'),
    },
];

async function compileInjectionScript(script: InjectionScript): Promise<void> {
    const source = script.sources.map((sourcePath) => readFileSync(sourcePath, 'utf8')).join('\n');
    const result = await transformWithOxc(source, script.sources[0] ?? script.name, {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
        sourcemap: false,
    });
    const output = `(function () {\n${result.code}\n})();\n`;

    mkdirSync(resolve(script.output, '..'), {recursive: true});
    const previous = (() => {
        try {
            return readFileSync(script.output, 'utf8');
        } catch {
            return null;
        }
    })();
    if (previous !== output) writeFileSync(script.output, output);
}

async function compileInjectionScripts(): Promise<void> {
    await Promise.all(injectionScripts.map(compileInjectionScript));
}

function injectionScriptPlugin(): Plugin {
    return {
        name: 'injection-scripts',
        async buildStart() {
            await compileInjectionScripts();
            for (const script of injectionScripts) {
                for (const source of script.sources) this.addWatchFile(source);
            }
        },
        async writeBundle() {
            await compileInjectionScripts();
        },
        async handleHotUpdate(context) {
            const affected = injectionScripts.filter((script) => script.sources.includes(context.file));
            await Promise.all(affected.map(compileInjectionScript));
        },
    };
}

export default defineConfig(({command}) => {
    const devApiOrigin = normalizeDevApiOrigin(
        process.env.JUNGLE_BELL_DEV_API_ORIGIN ?? defaultDevApiOrigin,
    );
    const productionTauriApiOrigin = tauriBuildApiOrigin(command, process.env);
    const developmentTauriOrigin = command === 'serve' ? tauriDevOrigin(process.env) : null;

    return {
        plugins: [
            react(),
            tailwindcss(),
            injectionScriptPlugin(),
            VitePWA({
                strategies: 'injectManifest',
                srcDir: 'service-worker',
                filename: 'sw.js',
                injectRegister: false,
                registerType: 'prompt',
                manifest: false,
                injectManifest: {
                    rollupFormat: 'iife',
                    globPatterns: [
                        'dashboard.html',
                        'manifest.webmanifest',
                        'icons/**/*.{png,svg,ico}',
                        'assets/**/*.{js,css,png,woff2,txt}',
                        'injected/**/*.js',
                    ],
                },
                devOptions: {enabled: false},
            }),
        ],
        resolve: {
            alias: {
                '@': resolve(import.meta.dirname, 'src'),
            },
        },
        root: 'src',
        cacheDir: '../node_modules/.vite',
        base: './',
        clearScreen: false,
        publicDir: 'public',
        define: command === 'serve'
            ? {
                'import.meta.env.VITE_CAMPUS_API_URL': JSON.stringify(devApiOrigin),
                'import.meta.env.VITE_PLATFORM_API_URL': JSON.stringify(''),
            }
            : productionTauriApiOrigin
                ? {
                    'import.meta.env.VITE_CAMPUS_API_URL': JSON.stringify(productionTauriApiOrigin),
                    'import.meta.env.VITE_PLATFORM_API_URL': JSON.stringify(productionTauriApiOrigin),
                }
                : undefined,
        server: {
            host: host ?? '127.0.0.1',
            port: 5173,
            strictPort: true,
            proxy: {
                '/api/desktop-ui': {
                    target: devApiOrigin,
                    changeOrigin: true,
                    secure: true,
                    ...(developmentTauriOrigin ? {headers: {origin: developmentTauriOrigin}} : {}),
                },
                '/api': {
                    target: devApiOrigin,
                    changeOrigin: true,
                    secure: true,
                    headers: {origin: devApiOrigin},
                    bypass: (request) => bypassDevApiModuleRequest(request.url),
                },
            },
        },
        // Tauri build variables are consumed by this Node-side config only. Never
        // expose the TAURI_ namespace to browser bundles because it can contain
        // updater signing material in release environments.
        envPrefix: ['VITE_'],
        build: {
            target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
            outDir: '../dist',
            emptyOutDir: true,
            sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
            minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
            rolldownOptions: {
                input: {
                    dashboard: resolve(import.meta.dirname, 'src/dashboard.html'),
                },
            },
        },
    };
});
