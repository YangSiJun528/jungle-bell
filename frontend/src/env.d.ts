/// <reference types="vite/client" />

declare const __JUNGLE_BELL_TARGET__: 'web' | 'desktop';
declare const __JUNGLE_BELL_BUILD_CONFIG__:
    | {target: 'web'; platformApiUrl: null}
    | {target: 'desktop'; platformApiUrl: string};
