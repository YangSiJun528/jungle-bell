import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, transformWithOxc, type Plugin} from 'vite';

const host = process.env.TAURI_DEV_HOST;

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

function serviceWorkerAssetsPlugin(): Plugin {
    return {
        name: 'service-worker-assets',
        apply: 'build',
        writeBundle(_options, bundle) {
            const assets = Object.values(bundle)
                .map((entry) => entry.fileName)
                .filter((fileName) => /\.(?:css|js|txt|woff2)$/u.test(fileName))
                .sort()
                .map((fileName) => `./${fileName}`);
            const buildId = createHash('sha256')
                .update(JSON.stringify(assets))
                .digest('hex')
                .slice(0, 12);
            const outputDirectory = resolve(import.meta.dirname, 'dist');
            writeFileSync(
                resolve(outputDirectory, 'sw-assets.json'),
                `${JSON.stringify({version: 1, assets})}\n`,
            );
            const serviceWorkerPath = resolve(outputDirectory, 'sw.js');
            const serviceWorker = readFileSync(serviceWorkerPath, 'utf8')
                .replaceAll('__BUILD_ID__', buildId);
            writeFileSync(serviceWorkerPath, serviceWorker);
        },
    };
}

export default defineConfig({
    plugins: [react(), tailwindcss(), injectionScriptPlugin(), serviceWorkerAssetsPlugin()],
    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src'),
        },
    },
    root: 'src',
    base: './',
    clearScreen: false,
    publicDir: 'public',
    server: {
        host: host ?? '127.0.0.1',
        port: 5173,
        strictPort: true,
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
                imageViewer: resolve(import.meta.dirname, 'src/image-viewer.html'),
                dashboard: resolve(import.meta.dirname, 'src/dashboard.html'),
            },
        },
    },
});
