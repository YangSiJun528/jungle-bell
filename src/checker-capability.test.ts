import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const checkerSource = readFileSync(new URL('./injected/checker.ts', import.meta.url), 'utf8');
const attendanceSource = readFileSync(new URL('./injected/attendance.ts', import.meta.url), 'utf8');
const buildSource = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const capabilityDirectory = new URL('../src-tauri/capabilities/', import.meta.url);
const localCapabilities = readdirSync(capabilityDirectory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => JSON.parse(readFileSync(new URL(path, capabilityDirectory), 'utf8')) as {
        local?: boolean;
        permissions: string[];
    })
    .filter((capability) => capability.local !== false);
const checkerCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/checker.json', import.meta.url), 'utf8'),
) as {
    local: boolean;
    permissions: string[];
    remote: {urls: string[]};
    windows: string[];
};
const attendanceCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/attendance.json', import.meta.url), 'utf8'),
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

function attendanceInvokeCommands(): string[] {
    return captures(
        attendanceSource,
        /window\.__TAURI__\.core\.invoke(?:<[^>]+>)?\(\s*['"]([a-z0-9_]+)['"]/g,
    );
}

test('모든 앱 명령은 manifest와 하나 이상의 로컬 capability에 명시된다', () => {
    const registered = sorted(new Set(invokeHandlerCommands()));
    const manifested = sorted(new Set(appManifestCommands()));
    const locallyAllowed = sorted(
        new Set(
            localCapabilities.flatMap((capability) =>
                capability.permissions.filter((permission) => permission.startsWith('allow-')),
            ),
        ),
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

test('원격 출석 창은 클릭 보고 명령 하나만 허용한다', () => {
    const invoked = sorted(new Set(attendanceInvokeCommands()));

    assert.deepEqual(attendanceCapability.windows, ['attendance']);
    assert.equal(attendanceCapability.local, false);
    assert.deepEqual(attendanceCapability.remote.urls, ['https://jungle-lms.krafton.com/*']);
    assert.deepEqual(sorted(attendanceCapability.permissions), invoked.map(allowPermission));
    assert.deepEqual(invoked, ['report_attendance_start_clicked']);
});

test('checker는 LMS 기수 목록을 로컬 선택 규칙으로 해석한 뒤 해당 출석만 조회한다', () => {
    assert.match(checkerSource, /\/api\/v2\/me\/cohorts/);
    assert.match(checkerSource, /resolve_cohort_selection/);
    assert.match(checkerSource, /cohortOptions/);
    assert.match(checkerSource, /fetchAttendance\(selection\.cohort_id\)/);
});
