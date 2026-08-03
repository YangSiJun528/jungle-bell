---
name: release
description: Create the canonical Jungle Bell platform GitHub release from the version in platform/apps/desktop/src-tauri/Cargo.toml. Use when the user asks to create or publish a release, says "릴리즈 만들어줘", "release", or "/release". Validates the renewed workspace, uses immutable platform-v tags, and dispatches the signed platform release workflow.
---

# Release

Publish only through `.github/workflows/platform-release.yml`. Do not recreate
the removed legacy root release workflow or build the legacy root Tauri app.

## Interaction compatibility

When approval is required, ask one concise Korean question with the runtime's
available user-input mechanism and wait for the answer.

## 1. Validate local state

1. Require branch `main`.
2. Refuse if staged, unstaged, or untracked changes exist.
3. Fetch `origin` and require local `main` to equal `origin/main`. Ask before
   pushing local commits; abort if the user declines.
4. Require repository variables `JB_APP_ORIGIN` and `JB_API_ORIGIN` to exist and
   contain the same HTTPS origin.
5. Require the repository's GitHub immutable releases setting to be enabled.
   Require an Actions secret named `RELEASE_SETTINGS_READ_TOKEN` containing a
   fine-grained token with only `Administration: read`, and check
   `GET /repos/{owner}/{repo}/immutable-releases`. Do not enable or change the
   repository setting without a separate explicit user request.

## 2. Validate the version

Read the version from
`platform/apps/desktop/src-tauri/Cargo.toml`. Require canonical SemVer and the
same value in:

- `platform/package.json` and its root/workspace entries in `package-lock.json`
- `platform/apps/api/package.json`
- `platform/apps/desktop/package.json`
- `platform/apps/web/package.json`
- `platform/apps/desktop/src-tauri/tauri.conf.json`
- the `jungle-bell-desktop` entry in `Cargo.lock`

Use tag `platform-v{version}`. Refuse if that remote tag or GitHub release
already exists. Published releases and immutable tags are never force-replaced;
use `$bump-version` and retry.

Run from `platform/`:

```bash
npm run test:ops
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 3. Review the release delta

For a stable version, find the previous stable `platform-vMAJOR.MINOR.PATCH`
tag and summarize the net user-visible delta to `HEAD` in concise Korean under
`새 기능`, `버그 수정`, and `기타`. Exclude intermediate prerelease churn,
internal refactors, documentation, and release tooling. For a prerelease,
summarize the delta without requiring stable-release notes.

Show the summary and exact version/tag, then ask whether to dispatch. Abort if
the user declines. The workflow creates the draft release and generated notes;
do not create or push the tag separately because tag pushes also trigger the
same workflow.

## 4. Dispatch and follow

Record `git rev-parse HEAD`, then run:

```bash
gh workflow run platform-release.yml \
  -f tag=platform-v{version} \
  -f ref={full_commit_sha} \
  -f prerelease={true_or_false}
```

Find the matching `workflow_dispatch` run and report its URL. The workflow owns
quality gates, immutable tag/draft creation, updater-signature verification,
desktop/server artifacts, publication, and stable `latest` selection. Do not
claim the release is published until that run succeeds.
