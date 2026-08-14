import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';

const target = process.argv[2];
if (target !== 'web' && target !== 'desktop') {
    throw new Error('BUILD_ARTIFACT_TARGET_REQUIRED');
}

const output = resolve(import.meta.dirname, '..', 'dist', target);
const required = target === 'web'
    ? ['index.html', 'manifest.webmanifest', 'sw.js', '_headers']
    : ['index.html', 'injected/checker.js'];
const forbidden = target === 'web'
    ? ['injected/checker.js']
    : ['manifest.webmanifest', 'sw.js', '_headers', 'icons'];

for (const path of required) {
    if (!existsSync(resolve(output, path))) throw new Error(`BUILD_ARTIFACT_MISSING:${path}`);
}
for (const path of forbidden) {
    if (existsSync(resolve(output, path))) throw new Error(`BUILD_ARTIFACT_LEAKED:${path}`);
}

const text = textFiles(output).map((path) => readFileSync(path, 'utf8')).join('\n');
if (target === 'web') {
    for (const nativeLiteral of [
        'bootstrap_desktop_http_session',
        'get_desktop_settings',
        'open_lms_login',
        'get_notification_inbox_snapshot',
    ]) {
        if (text.includes(nativeLiteral)) throw new Error(`WEB_NATIVE_CODE_LEAKED:${nativeLiteral}`);
    }
} else if (/manifest\.webmanifest|serviceWorker\.register|beforeinstallprompt/u.test(text)) {
    throw new Error('DESKTOP_PWA_CODE_LEAKED');
}

function textFiles(directory) {
    return readdirSync(directory, {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile() && /\.(?:html|js|css|webmanifest)$/u.test(entry.name))
        .map((entry) => resolve(entry.parentPath, entry.name));
}
