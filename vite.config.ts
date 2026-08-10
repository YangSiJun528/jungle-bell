import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
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

export default defineConfig({
    plugins: [tailwindcss(), injectionScriptPlugin()],
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
