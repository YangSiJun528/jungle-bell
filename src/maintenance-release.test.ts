import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const rustRoot = new URL('../src-tauri/', import.meta.url);
const libSource = readFileSync(new URL('src/lib.rs', rustRoot), 'utf8');
const commandsSource = readFileSync(new URL('src/commands.rs', rustRoot), 'utf8');
const configSource = readFileSync(new URL('src/config.rs', rustRoot), 'utf8');
const stateSource = readFileSync(new URL('src/state.rs', rustRoot), 'utf8');
const traySource = readFileSync(new URL('src/tray.rs', rustRoot), 'utf8');
const buildSource = readFileSync(new URL('build.rs', rustRoot), 'utf8');
const cargoSource = readFileSync(new URL('Cargo.toml', rustRoot), 'utf8');
const settingsSource = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
const settingsHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};
const packageLock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
) as {version: string; packages: Record<string, {version?: string}>};
const capability = JSON.parse(
    readFileSync(new URL('capabilities/default.json', rustRoot), 'utf8'),
) as {permissions: string[]};
const tauriConfig = JSON.parse(
    readFileSync(new URL('tauri.conf.json', rustRoot), 'utf8'),
) as {
    version: string;
    identifier: string;
    plugins: {updater?: {endpoints?: string[]}};
    bundle: {createUpdaterArtifacts?: boolean};
};

test('0.4.5 런타임에는 자동·수동·주기 업데이트 경로가 없다', () => {
    assert.equal(existsSync(new URL('src/updater.rs', rustRoot)), false);
    assert.doesNotMatch(
        libSource,
        /mod updater|tauri_plugin_updater|spawn_startup_update_check|spawn_periodic_update_check/,
    );
    assert.doesNotMatch(commandsSource, /auto_update|pending_update|check_and_notify_update|crate::updater/);
    assert.doesNotMatch(buildSource, /auto_update|pending_update|check_and_notify_update/);
    assert.doesNotMatch(cargoSource, /tauri-plugin-updater/);
    assert.doesNotMatch(configSource, /auto_update/);
    assert.doesNotMatch(stateSource, /pending_update/);
    assert.ok(!capability.permissions.includes('updater:default'));
    assert.ok(!capability.permissions.some((permission) => /auto-update|pending-update|notify-update/.test(permission)));
});

test('0.4.5 설정 화면에는 업데이트 상태와 조작 기능이 없다', () => {
    assert.doesNotMatch(settingsSource, /autoUpdate|pendingVersion|refreshUpdateStatus|get_auto_update|get_pending_update/);
    assert.doesNotMatch(settingsHtml, /자동 업데이트|업데이트 가능|check_and_notify_update|set_auto_update/);
});

test('트레이 유지보수 종료 항목은 안내 후 GitHub 이동 또는 닫기를 제공한다', () => {
    assert.match(
        traySource,
        /MenuItemBuilder::with_id\("maintenance_notice", "더 이상 유지보수 되지 않음"\)/,
    );
    assert.match(traySource, /"maintenance_notice" => show_maintenance_notice\(app\)/);
    assert.match(
        traySource,
        /const PROJECT_URL: &str =\s*"https:\/\/github\.com\/YangSiJun528\/jungle-bell";/,
    );
    assert.match(traySource, /현재 리뉴얼 중/);
    assert.match(traySource, /더 이상 유지보수되지 않/);
    assert.match(traySource, /직접 새로 설치/);
    assert.match(traySource, /MessageDialogButtons::OkCancelCustom/);
    assert.match(traySource, /"GitHub로 이동"\.into\(\)/);
    assert.match(traySource, /"닫기"\.into\(\)/);
});

test('0.4.4에서 한 번 전달할 0.4.5 산출물 계약을 유지한다', () => {
    assert.equal(packageJson.version, '0.4.5');
    assert.equal(packageLock.version, '0.4.5');
    assert.equal(packageLock.packages['']?.version, '0.4.5');
    assert.match(cargoSource, /^version = "0\.4\.5"$/m);
    assert.equal(tauriConfig.version, '0.4.5');
    assert.equal(tauriConfig.identifier, 'dev.sijun-yang.jungle-bell');
    assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
    assert.deepEqual(tauriConfig.plugins.updater?.endpoints, [
        'https://github.com/YangSiJun528/jungle-bell/releases/latest/download/latest.json',
    ]);
});
