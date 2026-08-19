import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url);
const repoSource = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8');

const tauriConfig = JSON.parse(repoSource('desktop/tauri.conf.json')) as {
    identifier?: string;
    plugins?: {updater?: {endpoints?: string[]}};
};
const releaseWorkflow = repoSource('.github/workflows/release.yml');

test('리뉴얼 앱은 기존 앱과 다른 식별자와 v2 업데이트 채널을 사용한다', () => {
    assert.equal(tauriConfig.identifier, 'dev.sijun-yang.jungle-bell.v2');
    assert.notEqual(tauriConfig.identifier, 'dev.sijun-yang.jungle-bell');
    assert.deepEqual(tauriConfig.plugins?.updater?.endpoints, [
        'https://github.com/YangSiJun528/jungle-bell/releases/latest/download/latest-v2.json',
    ]);
});

test('v2 업데이트 매니페스트는 초안 릴리스 안에서만 생성해 전용 이름으로 공개한다', () => {
    assert.match(releaseWorkflow, /^\s*workflow_dispatch:\s*$/mu);
    assert.doesNotMatch(releaseWorkflow, /^\s*release:\s*$/mu);
    assert.match(releaseWorkflow, /IS_DRAFT/);
    assert.match(releaseWorkflow, /if \[ "\$IS_DRAFT" != "true" \]; then/);
    assert.match(releaseWorkflow, /uploadUpdaterJson:\s*true/);
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
