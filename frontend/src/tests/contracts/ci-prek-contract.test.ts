import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {test} from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url);
const repoSource = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8');
const prekConfig = repoSource('prek.toml');
const ciWorkflow = repoSource('.github/workflows/ci.yml');
const prekHooks = prekConfig.split('[[repos.hooks]]').slice(1);
const prekHook = (id: string) => {
    const hook = prekHooks.find((candidate) => candidate.includes(`id = "${id}"`));
    assert.ok(hook, `${id} prek hook을 찾을 수 없다`);
    return hook;
};

test('prek는 빠른 pre-commit과 경로별 pre-push 검사를 설치한다', () => {
    assert.match(prekConfig, /minimum_prek_version = "0\.4\.9"/u);
    assert.match(prekConfig, /default_install_hook_types = \["pre-commit", "pre-push"\]/u);
    assert.match(prekHook('staged-diff-check'), /git diff --cached --check/u);
    assert.match(prekHook('no-commit-to-branch'), /"--branch", "main"/u);
    assert.match(prekHook('frontend-format'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('frontend-lint'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('desktop-rustfmt'), /stages = \["pre-commit"\]/u);
    assert.match(prekHook('frontend-check'), /stages = \["pre-push"\]/u);
    assert.match(prekHook('frontend-check'), /files = "\^\(frontend\|desktop\)\/"/u);
    assert.match(prekHook('server-check'), /stages = \["pre-push"\]/u);
    assert.match(prekHook('desktop-test'), /JUNGLE_BELL_DATA_API_URL/u);
    assert.match(prekHook('desktop-clippy'), /JUNGLE_BELL_DATA_API_URL/u);
    assert.doesNotMatch(prekConfig, /campus-observer/u);

    const localHooks = prekConfig.slice(prekConfig.indexOf('repo = "local"'));
    const localHookDefinitions = localHooks.split('[[repos.hooks]]').slice(1);
    assert.ok(localHookDefinitions.length > 0);
    for (const hook of localHookDefinitions) {
        assert.match(hook, /language = "system"/u);
        assert.match(hook, /pass_filenames = false/u);
    }
});

test('CI는 hygiene와 제품 검증을 고정 required 잡으로 집계한다', () => {
    assert.match(ciWorkflow, /^  hygiene:\s*$/mu);
    assert.match(
        ciWorkflow,
        /j178\/prek-action@[0-9a-f]{40}[\s\S]*prek-version: "0\.4\.14"[\s\S]*install-only: true/u,
    );
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
    assert.match(ciWorkflow, /if: \$\{\{ always\(\) \}\}/u);
    assert.match(ciWorkflow, /needs: \[hygiene, web, server, desktop\]/u);
    assert.match(ciWorkflow, /test "\$HYGIENE_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$WEB_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$SERVER_RESULT" = "success"/u);
    assert.match(ciWorkflow, /test "\$DESKTOP_RESULT" = "success"/u);
    assert.doesNotMatch(ciWorkflow, /actions\/upload-artifact/u);
    assert.doesNotMatch(ciWorkflow, /campus-observer/u);
    assert.doesNotMatch(ciWorkflow, /^\s+paths(?:-ignore)?:/mu);
});
