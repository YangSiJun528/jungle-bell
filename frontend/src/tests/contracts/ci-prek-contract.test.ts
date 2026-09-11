import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {test} from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url);
const repoSource = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8');
const miseConfig = repoSource('mise.toml');
const prekConfig = repoSource('prek.toml');
const ciWorkflow = repoSource('.github/workflows/ci.yml');
const releaseWorkflow = repoSource('.github/workflows/release.yml');
const prekHooks = prekConfig.split('[[repos.hooks]]').slice(1);
const prekHook = (id: string) => {
    const hook = prekHooks.find((candidate) => candidate.includes(`id = "${id}"`));
    assert.ok(hook, `${id} prek hook을 찾을 수 없다`);
    return hook;
};

test('prek는 빠른 pre-commit과 경로별 pre-push 검사를 설치한다', () => {
    assert.match(prekConfig, /minimum_prek_version = "0\.4\.14"/u);
    assert.match(prekConfig, /default_install_hook_types = \["pre-commit", "pre-push"\]/u);
    assert.match(prekHook('staged-diff-check'), /git --no-pager diff --cached --check/u);
    assert.match(prekHook('no-commit-to-branch'), /"--branch", "main"/u);
    assert.match(prekHook('frontend-format'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('frontend-format'), /entry = "mise exec -- npm/u);
    assert.match(prekHook('frontend-lint'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('frontend-lint'), /entry = "mise exec -- npm/u);
    assert.match(prekHook('desktop-rustfmt'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('desktop-rustfmt'), /entry = "mise exec -- cargo/u);
    assert.match(prekHook('frontend-check'), /stages = \["pre-push"\]/u);
    assert.match(prekHook('frontend-check'), /files = "\^\(frontend\|desktop\)\/"/u);
    assert.match(prekHook('frontend-check'), /entry = "mise exec -- npm/u);
    assert.match(prekHook('server-check'), /stages = \["pre-push"\]/u);
    assert.match(prekHook('server-check'), /entry = "mise exec -- \.\/server\/gradlew/u);
    assert.match(prekHook('desktop-test'), /JUNGLE_BELL_DATA_API_URL/u);
    assert.match(prekHook('desktop-test'), /entry = "mise exec -- cargo/u);
    assert.match(prekHook('desktop-clippy'), /JUNGLE_BELL_DATA_API_URL/u);
    assert.match(prekHook('desktop-clippy'), /entry = "mise exec -- cargo/u);
    assert.doesNotMatch(prekConfig, /campus-observer/u);

    const localHooks = prekConfig.slice(prekConfig.indexOf('repo = "local"'));
    const localHookDefinitions = localHooks.split('[[repos.hooks]]').slice(1);
    assert.ok(localHookDefinitions.length > 0);
    for (const hook of localHookDefinitions) {
        assert.match(hook, /language = "system"/u);
        assert.match(hook, /pass_filenames = false/u);
    }
});

test('mise는 로컬과 GitHub Actions의 개발 도구 버전 정책을 통일한다', () => {
    assert.match(miseConfig, /^min_version = "2025\.8\.11"$/mu);
    assert.match(miseConfig, /^node = "24"$/mu);
    assert.match(miseConfig, /^java = "temurin-21"$/mu);
    assert.match(miseConfig, /^prek = "0\.4\.14"$/mu);
    assert.match(
        miseConfig,
        /^rust = \{ version = "stable", profile = "minimal", components = \[\s*"rustfmt",\s*"clippy",\s*\] \}$/mu,
    );

    assert.equal(ciWorkflow.match(/jdx\/mise-action@[0-9a-f]{40}/gu)?.length, 4);
    assert.equal(releaseWorkflow.match(/jdx\/mise-action@[0-9a-f]{40}/gu)?.length, 2);
    assert.equal(ciWorkflow.match(/version: "2026\.9\.5"/gu)?.length, 4);
    assert.equal(releaseWorkflow.match(/version: "2026\.9\.5"/gu)?.length, 2);
    assert.match(ciWorkflow, /^          install_args: prek$/mu);
    assert.match(ciWorkflow, /^          install_args: node$/mu);
    assert.match(ciWorkflow, /^          install_args: java$/mu);
    assert.match(ciWorkflow, /^          install_args: node rust$/mu);
    assert.match(releaseWorkflow, /^          install_args: node$/mu);
    assert.match(releaseWorkflow, /^          install_args: node rust$/mu);

    for (const workflow of [ciWorkflow, releaseWorkflow]) {
        assert.doesNotMatch(workflow, /actions\/setup-node/u);
        assert.doesNotMatch(workflow, /actions\/setup-java/u);
        assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain/u);
        assert.doesNotMatch(workflow, /node-version:/u);
        assert.doesNotMatch(workflow, /java-version:/u);
    }
    assert.doesNotMatch(ciWorkflow, /j178\/prek-action/u);
    assert.doesNotMatch(ciWorkflow, /prek-version:/u);
    assert.match(ciWorkflow, /gradle\/actions\/setup-gradle@[0-9a-f]{40} # v6\.3\.0/u);
    assert.equal(ciWorkflow.match(/actions\/cache@[0-9a-f]{40} # v6\.1\.0/gu)?.length, 2);
    assert.equal(releaseWorkflow.match(/actions\/cache@[0-9a-f]{40} # v6\.1\.0/gu)?.length, 1);
    assert.match(ciWorkflow, /rustup component add --toolchain stable rustfmt clippy/u);
    assert.match(
        releaseWorkflow,
        /rustup target add --toolchain stable aarch64-apple-darwin x86_64-apple-darwin/u,
    );
});

test('CI는 hygiene와 제품 검증을 고정 required 잡으로 집계한다', () => {
    assert.match(ciWorkflow, /^  hygiene:\s*$/mu);
    assert.match(ciWorkflow, /prek validate-config prek\.toml/u);
    assert.match(ciWorkflow, /prek run --all-files --group hygiene/u);
    assert.match(ciWorkflow, /^  web:\s*$/mu);
    assert.match(ciWorkflow, /^  server:\s*$/mu);
    assert.match(ciWorkflow, /^  desktop:\s*$/mu);
    assert.match(ciWorkflow, /^  required:\s*$/mu);
    assert.match(
        ciWorkflow,
        /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u,
    );
    assert.match(
        ciWorkflow,
        /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/u,
    );
    assert.equal(
        ciWorkflow.split(
            "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false",
        ).length - 1,
        4,
    );
    assert.match(
        ciWorkflow,
        /if: \$\{\{ always\(\) && \(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false\) \}\}/u,
    );
    assert.match(ciWorkflow, /needs: \[hygiene, web, server, desktop\]/u);
    assert.match(ciWorkflow, /test "\$HYGIENE_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$WEB_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$SERVER_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$DESKTOP_RESULT" = "success"/u);
    assert.doesNotMatch(ciWorkflow, /actions\/upload-artifact/u);
    assert.doesNotMatch(ciWorkflow, /campus-observer/u);
    assert.doesNotMatch(ciWorkflow, /^\s+paths(?:-ignore)?:/mu);
});
