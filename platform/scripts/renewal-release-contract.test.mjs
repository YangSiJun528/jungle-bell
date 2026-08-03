import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);

async function readJson(path) {
  return JSON.parse(
    await readFile(new URL(path, repositoryRoot), "utf8"),
  );
}

function versionTuple(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u.exec(
    version,
  );
  assert.ok(match, `invalid SemVer: ${version}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(left, right) {
  const leftParts = versionTuple(left);
  const rightParts = versionTuple(right);
  for (let index = 0; index < leftParts.core.length; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index];
    }
  }
  if (leftParts.prerelease.length === 0) {
    return rightParts.prerelease.length === 0 ? 0 : 1;
  }
  if (rightParts.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(
    leftParts.prerelease.length,
    rightParts.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts.prerelease[index];
    const rightPart = rightParts.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) - Number(rightPart);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

test("renewed desktop remains an in-place update of the released app", async () => {
  const legacy = await readJson("src-tauri/tauri.conf.json");
  const renewed = await readJson(
    "platform/apps/desktop/src-tauri/tauri.conf.json",
  );

  assert.equal(renewed.productName, legacy.productName);
  assert.equal(renewed.identifier, legacy.identifier);
  assert.ok(compareVersions(renewed.version, legacy.version) > 0);
  assert.deepEqual(renewed.plugins?.updater, legacy.plugins?.updater);
  assert.equal(renewed.bundle?.createUpdaterArtifacts, true);
});

test("platform release publishes the canonical signed updater feed", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/platform-release.yml", repositoryRoot),
    "utf8",
  );

  assert.match(workflow, /uploadUpdaterJson:\s*true/u);
  assert.match(workflow, /max-parallel:\s*1/u);
  assert.match(workflow, /make_latest="false"/u);
  assert.match(workflow, /make_latest="true"/u);
  assert.match(workflow, /-f make_latest="\$make_latest"/u);
  assert.match(workflow, /latest\.json/u);
  assert.match(workflow, /verify-updater-manifest\.mjs/u);
  assert.match(workflow, /--example verify_updater_signature/u);
  assert.match(workflow, /cmp --silent/u);
  assert.match(workflow, /UPDATER_MANIFEST_ASSET_ID/u);
  assert.match(workflow, /checked_assets.*-ne 6/su);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/immutable-releases/u);
  assert.match(workflow, /secrets\.RELEASE_SETTINGS_READ_TOKEN/u);
  assert.ok(
    [...workflow.matchAll(/immutable-releases/gu)].length >= 2,
    "immutable release settings must be checked before build and publish",
  );
  const actionReferences = [
    ...workflow.matchAll(/^\s+uses:\s+[^@\s]+@([^\s#]+)/gmu),
  ];
  assert.ok(actionReferences.length > 0);
  for (const [, reference] of actionReferences) {
    assert.match(reference, /^[0-9a-f]{40}$/u);
  }
});

test("prerelease versions retain SemVer ordering above the legacy app", () => {
  assert.ok(compareVersions("0.5.1-beta.1", "0.4.4") > 0);
  assert.ok(compareVersions("0.5.1-beta.2", "0.5.1-beta.1") > 0);
  assert.ok(compareVersions("0.5.1-1beta", "0.5.1-1") > 0);
  assert.ok(compareVersions("0.5.1", "0.5.1-rc.1") > 0);
});

test("legacy release workflow cannot replace the renewed feed", async () => {
  await assert.rejects(
    readFile(
      new URL(".github/workflows/release.yml", repositoryRoot),
      "utf8",
    ),
    { code: "ENOENT" },
  );
});
