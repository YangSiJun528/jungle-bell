import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const checkerSource = readFileSync(new URL('./injected/checker.ts', import.meta.url), 'utf8');
const buildSource = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const defaultCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as {permissions: string[]};
const checkerCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/checker.json', import.meta.url), 'utf8'),
) as {
    local: boolean;
    permissions: string[];
    remote: {urls: string[]};
    windows: string[];
};

function sorted(values: Iterable<string>): string[] {
    return [...values].sort();
}

function allowPermission(command: string): string {
    return `allow-${command.replaceAll('_', '-')}`;
}

function captures(source: string, pattern: RegExp): string[] {
    return [...source.matchAll(pattern)].flatMap((entry) => entry[1] ? [entry[1]] : []);
}

function appManifestCommands(): string[] {
    const match = buildSource.match(/const APP_COMMANDS:\s*&\[&str\]\s*=\s*&\[(.*?)];/s);
    assert.ok(match, 'build.rs에 APP_COMMANDS manifest가 필요합니다.');
    const body = match[1];
    assert.ok(body);
    return captures(body, /"([a-z0-9_]+)"/g);
}

function invokeHandlerCommands(): string[] {
    const match = appSource.match(/invoke_handler\(tauri::generate_handler!\[(.*?)\]\)/s);
    assert.ok(match, 'invoke_handler 명령 목록을 찾을 수 없습니다.');
    const body = match[1];
    assert.ok(body);
    return captures(body, /commands::([a-z0-9_]+)/g);
}

function checkerInvokeCommands(): string[] {
    return captures(
        checkerSource,
        /window\.__TAURI__\.core\.invoke(?:<[^>]+>)?\(\s*['"]([a-z0-9_]+)['"]/g,
    );
}

test('모든 앱 명령은 manifest와 로컬 capability에 명시된다', () => {
    const registered = sorted(new Set(invokeHandlerCommands()));
    const manifested = sorted(new Set(appManifestCommands()));
    const locallyAllowed = sorted(
        defaultCapability.permissions.filter((permission) => permission.startsWith('allow-')),
    );

    assert.deepEqual(manifested, registered);
    assert.deepEqual(locallyAllowed, registered.map(allowPermission));
});

test('원격 checker는 필요한 명령과 event listen 권한만 가진다', () => {
    const invoked = sorted(new Set(checkerInvokeCommands()));
    const expectedPermissions = sorted([
        'core:event:allow-listen',
        ...invoked.map(allowPermission),
    ]);

    assert.deepEqual(checkerCapability.windows, ['checker']);
    assert.equal(checkerCapability.local, false);
    assert.deepEqual(checkerCapability.remote.urls, ['https://jungle-lms.krafton.com/*']);
    assert.deepEqual(sorted(checkerCapability.permissions), expectedPermissions);
});
