import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const checkerSource = readFileSync(new URL('./injected/checker.ts', srcRoot), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', srcRoot), 'utf8')) as {
    scripts?: Record<string, string>;
};
const buildSource = readFileSync(new URL('../src-tauri/build.rs', srcRoot), 'utf8');
const appSource = readFileSync(new URL('../src-tauri/src/lib.rs', srcRoot), 'utf8');
const checkerRuntimeSource = readFileSync(new URL('../src-tauri/src/checker.rs', srcRoot), 'utf8');
const tauriConfig = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', srcRoot), 'utf8'),
) as {
    app: {security: {freezePrototype?: boolean}};
};
const capabilityDirectory = new URL('../src-tauri/capabilities/', srcRoot);
type CapabilityPermission = string | {identifier: string};
const capabilities = readdirSync(capabilityDirectory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => JSON.parse(readFileSync(new URL(path, capabilityDirectory), 'utf8')) as {
        local?: boolean;
        permissions: CapabilityPermission[];
    });
const checkerCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/checker.json', srcRoot), 'utf8'),
) as {
    local: boolean;
    permissions: CapabilityPermission[];
    remote: {urls: string[]};
    windows: string[];
};

function sorted(values: Iterable<string>): string[] {
    return [...values].sort();
}

function allowPermission(command: string): string {
    return `allow-${command.replaceAll('_', '-')}`;
}

function permissionIdentifier(permission: CapabilityPermission): string {
    return typeof permission === 'string' ? permission : permission.identifier;
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

test('모든 앱 명령은 manifest와 하나 이상의 capability에 명시된다', () => {
    const registered = sorted(new Set(invokeHandlerCommands()));
    const manifested = sorted(new Set(appManifestCommands()));
    const allowed = sorted(
        new Set(
            capabilities.flatMap((capability) =>
                capability.permissions
                    .map(permissionIdentifier)
                    .filter((permission) => permission.startsWith('allow-')),
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
    assert.deepEqual(sorted(checkerCapability.permissions.map(permissionIdentifier)), expectedPermissions);
    assert.deepEqual(invoked, ['report_checker_event']);
    assert.match(checkerSource, /type: 'ready'/);
    assert.match(checkerSource, /type: 'log'/);
    assert.match(checkerSource, /type: 'resolveCohort'/);
    assert.match(checkerSource, /type: 'attendanceSnapshot'/);
    assert.doesNotMatch(
        checkerSource,
        /['"](?:report_checker_ready|log_from_js|resolve_cohort_selection|report_attendance_status)['"]/,
    );
    assert.match(checkerSource, /Number\.isSafeInteger\(generation\)/);
});

test('desktop 검증은 Rust 컴파일 전에 checker injection을 생성한다', () => {
    assert.match(rootPackage.scripts?.['verify:desktop'] ?? '', /^npm run build:app && cargo fmt /);
});

test('LMS WebView는 외부 페이지 실행을 깨뜨리는 전역 옵션을 사용하지 않는다', () => {
    // Tauri의 freezePrototype는 모든 WebView의 초기화 스크립트에서
    // Object.prototype을 freeze한다. 외부 LMS의 Next.js 런타임도 같은
    // WebView에서 실행되므로 글로벌 옵션을 사용하지 않는다.
    assert.notEqual(tauriConfig.app.security.freezePrototype, true);

    const checkerBuilder = checkerRuntimeSource.match(
        /WebviewWindowBuilder::new\([\s\S]*?"checker"[\s\S]*?\)\s*\.title\("Jungle Campus"\)([\s\S]*?)\.build\(\)\?;/,
    )?.[0];
    assert.ok(checkerBuilder, 'checker WebView builder를 찾을 수 없습니다.');
    assert.match(checkerBuilder, /WebviewUrl::External\(ATTENDANCE_URL\.parse\(\)\.unwrap\(\)\)/);
    assert.match(checkerBuilder, /\.visible\(false\)/);
    assert.match(checkerBuilder, /\.focused\(false\)/);
    assert.match(checkerBuilder, /\.skip_taskbar\(true\)/);
    assert.match(checkerBuilder, /\.initialization_script\(checker_script\)/);
    assert.doesNotMatch(checkerBuilder, /\.user_agent\(/);

    // 기존 체커는 출석 URL에 머물러 있으면 reload, 로그인 등
    // 다른 URL에 있으면 같은 WebView를 navigate하여 세션 store를 유지한다.
    assert.match(checkerRuntimeSource, /CheckerRefreshAction::Reload\s*=>[\s\S]*?checker\.reload\(\)/);
    assert.match(checkerRuntimeSource, /CheckerRefreshAction::Navigate\s*=>[\s\S]*?checker\.navigate\(target\)/);
});

test('구형 출석 WebView injection과 capability는 제거한다', () => {
    assert.equal(existsSync(new URL('./injected/attendance.ts', srcRoot)), false);
    assert.equal(existsSync(new URL('./injected/attendance-decision.ts', srcRoot)), false);
    assert.equal(existsSync(new URL('../src-tauri/capabilities/attendance.json', srcRoot)), false);
});

test('checker는 LMS 기수 목록을 단일 tagged IPC로 해석한 뒤 해당 출석만 조회한다', () => {
    assert.match(checkerSource, /\/api\/v2\/me\/cohorts/);
    assert.match(checkerSource, /reportCheckerEvent\(\{type: 'resolveCohort', cohortOptions\}\)/);
    assert.match(checkerSource, /INVALID_COHORT_SELECTION_RESPONSE/);
    assert.match(checkerSource, /cohortOptions/);
    assert.match(checkerSource, /fetchAttendance\(selection\.cohort_id\)/);
});

test('checker는 LMS 사용자 식별자를 조회하거나 분석 식별자로 전달하지 않는다', () => {
    assert.doesNotMatch(checkerSource, /\/api\/v2\/me['"`]/);
    assert.doesNotMatch(checkerSource, /report_cms_identity/);
    assert.doesNotMatch(checkerSource, /get_usage_analytics_enabled/);
});
