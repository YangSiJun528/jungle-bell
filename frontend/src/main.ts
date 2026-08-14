if (__JUNGLE_BELL_TARGET__ === 'desktop') {
    void import('@/platform/tauri/entry').then(({startDesktopApp}) => startDesktopApp());
} else {
    void import('@/platform/web/entry').then(({startWebApp}) => startWebApp());
}
