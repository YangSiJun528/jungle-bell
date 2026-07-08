import path from 'path';
import {fileURLToPath} from 'url';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import {defineConfig} from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const lightningcssTargets = {
  chrome: 123 << 16,
  firefox: 120 << 16,
  safari: (17 << 16) | (5 << 8),
};

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'astryx-css-layer-order',
      transformIndexHtml() {
        return [
          {
            tag: 'style',
            children:
              '@layer reset, priority1, priority2, priority3, priority4, priority5, priority6, priority7, priority8, priority9, astryx-theme;',
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    stylex.vite({
      dev: process.env.NODE_ENV === 'development',
      runtimeInjection: false,
      treeshakeCompensation: true,
      useCSSLayers: true,
      unstable_moduleResolution: {
        type: 'commonJS',
        rootDir: __dirname,
      },
      lightningcssOptions: {
        targets: lightningcssTargets,
      },
    }),
    react(),
  ],
  resolve: {
    alias: [
      {
        find: '@astryxdesign/core/astryx.css',
        replacement: path.resolve(__dirname, 'node_modules/@astryxdesign/core/dist/astryx.css'),
      },
      {
        find: '@astryxdesign/core/reset.css',
        replacement: path.resolve(__dirname, 'node_modules/@astryxdesign/core/src/reset.css'),
      },
      {
        find: '@astryxdesign/core/theme/tokens.stylex',
        replacement: path.resolve(
          __dirname,
          'node_modules/@astryxdesign/core/src/theme/tokens.stylex.ts',
        ),
      },
      {
        find: '@astryxdesign/core',
        replacement: path.resolve(__dirname, 'node_modules/@astryxdesign/core/src'),
      },
    ],
  },
  optimizeDeps: {
    exclude: ['@astryxdesign/core', '@astryxdesign/theme-neutral'],
  },
  build: {
    rollupOptions: {
      input: {
        settings: path.resolve(__dirname, 'index.html'),
        onboarding: path.resolve(__dirname, 'onboarding.html'),
      },
    },
  },
});
