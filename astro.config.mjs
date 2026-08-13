import {defineConfig} from 'astro/config';

export default defineConfig({
    srcDir: './src/site',
    outDir: './.build/site',
    output: 'static',
    site: process.env.JUNGLE_BELL_PUBLIC_ORIGIN
        ?? 'http://127.0.0.1:8080',
    trailingSlash: 'never',
    build: {
        assets: 'blog-assets',
        format: 'directory',
    },
});
