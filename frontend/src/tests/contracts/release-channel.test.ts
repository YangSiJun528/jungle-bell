import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url);
const repoSource = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8');

const tauriConfig = JSON.parse(repoSource('desktop/tauri.conf.json')) as {
    bundle?: {macOS?: {signingIdentity?: string}};
    identifier?: string;
    plugins?: {updater?: {endpoints?: string[]}};
    version?: string;
};
const releaseWorkflow = repoSource('.github/workflows/release.yml');
const macInstaller = repoSource('install/jungle-bell.sh.tmpl');

const matchedVersion = (source: string, pattern: RegExp, label: string) => {
    const match = source.match(pattern);
    assert.ok(match?.[1], `${label} 버전을 찾을 수 없다`);
    return match[1];
};

test('Gradle·Vite·Tauri 릴리스 버전은 같은 허용 SemVer다', () => {
    const frontendPackage = JSON.parse(repoSource('frontend/package.json')) as {
        version?: string;
    };
    const frontendPackageLock = JSON.parse(repoSource('frontend/package-lock.json')) as {
        packages?: Record<string, {version?: string}>;
        version?: string;
    };
    const canonicalVersion = frontendPackage.version;

    assert.ok(canonicalVersion, 'Vite 애플리케이션 버전을 찾을 수 없다');
    assert.match(canonicalVersion, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u);

    const versionSurfaces = [
        ['Vite package-lock 루트', frontendPackageLock.version],
        ['Vite package-lock 워크스페이스', frontendPackageLock.packages?.['']?.version],
        [
            'Gradle',
            matchedVersion(
                repoSource('server/build.gradle.kts'),
                /allprojects\s*\{[\s\S]*?version = "([^"]+)"/u,
                'Gradle',
            ),
        ],
        [
            'Cargo manifest',
            matchedVersion(
                repoSource('desktop/Cargo.toml'),
                /^\[package\][\s\S]*?^version = "([^"]+)"/mu,
                'Cargo manifest',
            ),
        ],
        [
            'Cargo lock',
            matchedVersion(
                repoSource('desktop/Cargo.lock'),
                /\[\[package\]\]\nname = "jungle-bell"\nversion = "([^"]+)"/u,
                'Cargo lock',
            ),
        ],
        ['Tauri', tauriConfig.version],
    ] as const;

    for (const [label, version] of versionSurfaces) {
        assert.equal(version, canonicalVersion, `${label} 버전이 일치하지 않는다`);
    }

    assert.doesNotMatch(repoSource('server/Dockerfile'), /SNAPSHOT/u);
});

test('리뉴얼 앱은 기존 앱과 다른 식별자와 v2 업데이트 채널을 사용한다', () => {
    assert.equal(tauriConfig.identifier, 'dev.sijun-yang.jungle-bell.v2');
    assert.notEqual(tauriConfig.identifier, 'dev.sijun-yang.jungle-bell');
    assert.deepEqual(tauriConfig.plugins?.updater?.endpoints, [
        'https://github.com/YangSiJun528/jungle-bell/releases/latest/download/latest-v2.json',
    ]);
});

test('macOS 업데이트 산출물과 설치본은 유효한 앱 번들 서명을 보장한다', () => {
    assert.equal(tauriConfig.bundle?.macOS?.signingIdentity, '-');
    assert.match(releaseWorkflow, /codesign --verify --deep --strict/);
    assert.match(releaseWorkflow, /Identifier=dev\.sijun-yang\.jungle-bell\.v2/);
    assert.match(macInstaller, /codesign --verify --deep --strict/);
    assert.doesNotMatch(macInstaller, /codesign[^\n]+\|\| true/);
});

test('v2 업데이트 매니페스트는 초안 릴리스 안에서만 생성해 전용 이름으로 공개한다', () => {
    assert.match(releaseWorkflow, /^\s*workflow_dispatch:\s*$/mu);
    assert.doesNotMatch(releaseWorkflow, /^\s*release:\s*$/mu);
    assert.match(releaseWorkflow, /IS_DRAFT/);
    assert.match(releaseWorkflow, /if \[ "\$IS_DRAFT" != "true" \]; then/);
    assert.match(releaseWorkflow, /includeUpdaterJson:\s*true/);
    assert.match(releaseWorkflow, /^\s*publish-v2-updater-manifest:\s*$/mu);
    assert.match(releaseWorkflow, /gh release download "\$TAG"[\s\S]*--pattern latest\.json/);
    assert.match(
        releaseWorkflow,
        /mv "\$MANIFEST_DIR\/latest\.json" "\$MANIFEST_DIR\/latest-v2\.json"/,
    );
    assert.match(releaseWorkflow, /gh release upload "\$TAG"[\s\S]*latest-v2\.json/);
    assert.match(releaseWorkflow, /gh release delete-asset "\$TAG" latest\.json --yes/);

    const uploadV2 = releaseWorkflow.indexOf('"$MANIFEST_DIR/latest-v2.json"');
    const deleteLegacy = releaseWorkflow.indexOf('gh release delete-asset "$TAG" latest.json --yes');
    assert.ok(uploadV2 >= 0 && deleteLegacy > uploadV2);

    const publishRelease = releaseWorkflow.indexOf('publish-release:');
    assert.ok(publishRelease >= 0);
    assert.match(
        releaseWorkflow.slice(publishRelease),
        /needs:\s*\[[^\]]*publish-v2-updater-manifest[^\]]*\]/,
    );
});
