import {defineConfig} from 'astro/config';

export default defineConfig({
    output: 'static',
    site: process.env.JUNGLE_BELL_PUBLIC_ORIGIN
        ?? 'https://jungle-bell-api.yangsijun5528.workers.dev',
    trailingSlash: 'never',
    build: {
        assets: 'blog-assets',
        format: 'directory',
    },
});
