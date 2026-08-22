import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

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

test('릴리스 입력 검증기는 현재 버전 태그만 허용한다', () => {
    const frontendPackage = JSON.parse(repoSource('frontend/package.json')) as {
        version?: string;
    };
    const canonicalVersion = frontendPackage.version;
    assert.ok(canonicalVersion);

    const script = fileURLToPath(new URL('scripts/verify-release-version.mjs', repoRoot));
    const acceptedVersion = execFileSync(process.execPath, [script, `v${canonicalVersion}`], {
        encoding: 'utf8',
    }).trim();
    assert.equal(acceptedVersion, canonicalVersion);
    assert.throws(() => execFileSync(process.execPath, [script, 'v999.0.0'], {stdio: 'pipe'}));
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
    const deleteLegacy = releaseWorkflow.indexOf(
        'gh release delete-asset "$TAG" latest.json --yes',
    );
    assert.ok(uploadV2 >= 0 && deleteLegacy > uploadV2);

    const publishRelease = releaseWorkflow.indexOf('publish-release:');
    assert.ok(publishRelease >= 0);
    assert.match(
        releaseWorkflow.slice(publishRelease),
        /needs:\s*\[[^\]]*verify-draft-release[^\]]*\]/,
    );
});

test('데스크톱 릴리스는 exact SHA의 CI 통과 후 서명·공개 환경을 거친다', () => {
    assert.match(releaseWorkflow, /^permissions:\s*\n\s+contents:\s*read\s*$/mu);
    assert.match(releaseWorkflow, /group:\s*desktop-release/u);
    assert.match(releaseWorkflow, /cancel-in-progress:\s*false/u);
    assert.match(releaseWorkflow, /^\s*prepare-release:\s*$/mu);
    assert.match(releaseWorkflow, /actions:\s*read/u);
    const prepareRelease = releaseWorkflow.slice(
        releaseWorkflow.indexOf('  prepare-release:'),
        releaseWorkflow.indexOf('  publish-tauri:'),
    );
    assert.match(prepareRelease, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*write/u);
    assert.match(releaseWorkflow, /git merge-base --is-ancestor "\$SHA" origin\/main/u);
    assert.match(
        releaseWorkflow,
        /git checkout --detach "\$SHA"[\s\S]*node scripts\/verify-release-version\.mjs "\$TAG"/u,
    );
    assert.match(releaseWorkflow, /gh run list[\s\S]*--workflow ci\.yml/u);
    assert.match(releaseWorkflow, /headSha/u);
    assert.match(releaseWorkflow, /\.name == "required"/u);
    assert.match(releaseWorkflow, /ref:\s*\$\{\{ needs\.prepare-release\.outputs\.sha \}\}/u);
    assert.match(releaseWorkflow, /node-version:\s*24/u);
    assert.match(releaseWorkflow, /environment:\s*desktop-signing/u);
    assert.match(releaseWorkflow, /max-parallel:\s*1/u);
    assert.match(releaseWorkflow, /tauri-apps\/tauri-action@[0-9a-f]{40}/u);
    assert.match(releaseWorkflow, /^\s*verify-draft-release:\s*$/mu);
    const verifyDraftRelease = releaseWorkflow.slice(
        releaseWorkflow.indexOf('  verify-draft-release:'),
        releaseWorkflow.indexOf('  publish-release:'),
    );
    assert.match(verifyDraftRelease, /permissions:\s*\n\s+contents:\s*write/u);
    assert.match(releaseWorkflow, /Jungle\.Bell_\$\{VERSION\}_aarch64\.tar\.gz/u);
    assert.match(releaseWorkflow, /Jungle\.Bell_\$\{VERSION\}_x64\.tar\.gz/u);
    assert.match(releaseWorkflow, /Jungle\.Bell_\$\{VERSION\}_x64-setup\.exe/u);

    const publishRelease = releaseWorkflow.indexOf('publish-release:');
    assert.ok(publishRelease >= 0);
    const publishSource = releaseWorkflow.slice(publishRelease);
    assert.match(publishSource, /environment:\s*desktop-release/u);
    assert.match(publishSource, /contents:\s*write/u);
    assert.match(publishSource, /git rev-parse "refs\/tags\/\$TAG\^\{commit\}"/u);
    assert.match(publishSource, /gh release download "\$TAG"[\s\S]*latest-v2\.json/u);
    assert.match(publishSource, /"darwin-aarch64"[\s\S]*"windows-x86_64"/u);
    assert.match(publishSource, /"\$\{asset_name\}\.sig"/u);
});
