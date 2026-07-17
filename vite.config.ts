import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig, transformWithOxc, type Plugin} from 'vite';

const host = process.env.TAURI_DEV_HOST;
const checkerSource = resolve(import.meta.dirname, 'src/injected/checker.ts');
const checkerOutput = resolve(import.meta.dirname, 'dist/injected/checker.js');

async function compileChecker(): Promise<void> {
    const result = await transformWithOxc(readFileSync(checkerSource, 'utf8'), checkerSource, {
        lang: 'ts',
        sourceType: 'script',
        target: 'safari13',
        sourcemap: false,
    });
    const output = `(function () {\n${result.code}\n})();\n`;

    mkdirSync(resolve(checkerOutput, '..'), {recursive: true});
    const previous = (() => {
        try {
            return readFileSync(checkerOutput, 'utf8');
        } catch {
            return null;
        }
    })();
    if (previous !== output) writeFileSync(checkerOutput, output);
}

function checkerInjectionScript(): Plugin {
    return {
        name: 'checker-injection-script',
        async buildStart() {
            await compileChecker();
            this.addWatchFile(checkerSource);
        },
        async writeBundle() {
            await compileChecker();
        },
        async handleHotUpdate(context) {
            if (context.file === checkerSource) await compileChecker();
        },
    };
}

export default defineConfig({
    plugins: [checkerInjectionScript()],
    root: 'src',
    base: './',
    clearScreen: false,
    publicDir: false,
    server: {
        host: host ?? '127.0.0.1',
        port: 5173,
        strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
        target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
        outDir: '../dist',
        emptyOutDir: true,
        sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
        minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
        rolldownOptions: {
            input: {
                settings: resolve(import.meta.dirname, 'src/index.html'),
                onboarding: resolve(import.meta.dirname, 'src/onboarding.html'),
                campus: resolve(import.meta.dirname, 'src/campus.html'),
            },
        },
    },
});
