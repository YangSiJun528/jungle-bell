import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const checkerSource = readFileSync(new URL('./injected/checker.ts', import.meta.url), 'utf8');
const attendanceSource = readFileSync(new URL('./injected/attendance.ts', import.meta.url), 'utf8');
const buildSource = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const checkerRuntimeSource = readFileSync(new URL('../src-tauri/src/checker.rs', import.meta.url), 'utf8');
const traySource = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');
const tauriConfig = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as {
    app: {security: {freezePrototype?: boolean}};
};
const capabilityDirectory = new URL('../src-tauri/capabilities/', import.meta.url);
const capabilities = readdirSync(capabilityDirectory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => JSON.parse(readFileSync(new URL(path, capabilityDirectory), 'utf8')) as {
        local?: boolean;
        permissions: string[];
    });
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

test('모든 앱 명령은 manifest와 하나 이상의 capability에 명시된다', () => {
    const registered = sorted(new Set(invokeHandlerCommands()));
    const manifested = sorted(new Set(appManifestCommands()));
    const allowed = sorted(
        new Set(
            capabilities.flatMap((capability) =>
                capability.permissions.filter((permission) => permission.startsWith('allow-')),
            ),
        ),
    );

    assert.deepEqual(manifested, registered);
    assert.deepEqual(allowed, registered.map(allowPermission));
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

test('LMS WebView는 기존 네이티브 호환성을 변경하지 않는다', () => {
    // Tauri의 freezePrototype는 모든 WebView의 초기화 스크립트에서
    // Object.prototype을 freeze한다. 외부 LMS의 Next.js 런타임도 같은
    // WebView에서 실행되므로 글로벌 옵션을 사용하지 않는다.
    assert.notEqual(tauriConfig.app.security.freezePrototype, true);

    const checkerBuilder = checkerRuntimeSource.match(
        /WebviewWindowBuilder::new\([\s\S]*?"checker"[\s\S]*?\)\s*\.title\("Jungle Bell"\)([\s\S]*?)\.build\(\)\?;/,
    )?.[0];
    assert.ok(checkerBuilder, 'checker WebView builder를 찾을 수 없습니다.');
    assert.match(checkerBuilder, /WebviewUrl::External\(ATTENDANCE_URL\.parse\(\)\.unwrap\(\)\)/);
    assert.match(checkerBuilder, /\.visible\(false\)/);
    assert.match(checkerBuilder, /\.focused\(false\)/);
    assert.match(checkerBuilder, /\.skip_taskbar\(true\)/);
    assert.match(checkerBuilder, /\.initialization_script\(checker_script\)/);
    assert.doesNotMatch(checkerBuilder, /\.user_agent\(/);

    const attendanceBuilder = traySource.match(
        /WebviewWindowBuilder::new\([\s\S]*?"attendance"[\s\S]*?\.initialization_script\(attendance_script\)[\s\S]*?\.build\(\)/,
    )?.[0];
    assert.ok(attendanceBuilder, '출석 WebView builder를 찾을 수 없습니다.');
    assert.match(attendanceBuilder, /WebviewUrl::External\(ATTENDANCE_URL\.parse\(\)\.unwrap\(\)\)/);
    assert.doesNotMatch(attendanceBuilder, /\.user_agent\(/);

    // 기존 체커는 출석 URL에 머물러 있으면 reload, 로그인 등
    // 다른 URL에 있으면 같은 WebView를 navigate하여 세션 store를 유지한다.
    assert.match(checkerRuntimeSource, /CheckerRefreshAction::Reload\s*=>[\s\S]*?checker\.reload\(\)/);
    assert.match(checkerRuntimeSource, /CheckerRefreshAction::Navigate\s*=>[\s\S]*?checker\.navigate\(target\)/);
});

test('원격 출석 창은 클릭 보고와 기수 동기화 명령만 허용한다', () => {
    const invoked = sorted(new Set(attendanceInvokeCommands()));

    assert.deepEqual(attendanceCapability.windows, ['attendance']);
    assert.equal(attendanceCapability.local, false);
    assert.deepEqual(attendanceCapability.remote.urls, ['https://jungle-lms.krafton.com/*']);
    assert.deepEqual(sorted(attendanceCapability.permissions), invoked.map(allowPermission));
    assert.deepEqual(invoked, [
        'get_attendance_cohort_id',
        'report_attendance_start_clicked',
    ]);
});

test('출석 창은 페이지를 열 때 Jungle Bell 기수와 LMS 로컬 스토리지를 동기화한다', () => {
    assert.match(attendanceSource, /selected_cohort_id/);
    assert.match(attendanceSource, /get_attendance_cohort_id/);
    assert.match(attendanceSource, /localStorage\.getItem/);
    assert.match(attendanceSource, /localStorage\.(?:setItem|removeItem)/);
    assert.match(attendanceSource, /serializeLmsSelectedCohortId/);
    assert.match(attendanceSource, /isSerializedLmsSelectedCohortId/);
    assert.match(attendanceSource, /window\.location\.reload\(\)/);
});

test('checker는 LMS 기수 목록을 로컬 선택 규칙으로 해석한 뒤 해당 출석만 조회한다', () => {
    assert.match(checkerSource, /\/api\/v2\/me\/cohorts/);
    assert.match(checkerSource, /resolve_cohort_selection/);
    assert.match(checkerSource, /cohortOptions/);
    assert.match(checkerSource, /fetchAttendance\(selection\.cohort_id\)/);
});
