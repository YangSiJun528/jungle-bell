---
name: bump-version
description: Bump the canonical Jungle Bell platform version consistently. Use when the user asks to bump or update the version, or says "버전 올려줘", "bump version", or "/bump-version". Updates every platform npm workspace, package-lock, Tauri config, Cargo package, and Cargo.lock while leaving the retired legacy root app unchanged.
---

# Bump version

Update the renewed app under `platform/`; do not change the retired root Tauri
app. If the user did not provide a target, read the current platform version and
ask one concise question for the target version.

Require canonical SemVer, including an optional valid prerelease component.
Reject a target lower than or equal to the current version unless the user
explicitly requested an idempotent repair of inconsistent version files.

## Files

Keep the target version identical in:

1. `platform/package.json`
2. root and workspace entries in `platform/package-lock.json`
3. `platform/apps/api/package.json`
4. `platform/apps/desktop/package.json`
5. `platform/apps/web/package.json`
6. `platform/apps/desktop/src-tauri/Cargo.toml`
7. `platform/apps/desktop/src-tauri/tauri.conf.json`
8. the local package entry in `platform/apps/desktop/src-tauri/Cargo.lock`

## Procedure

1. Read all current values and stop on unexplained divergence.
2. From `platform/`, update npm root and workspaces without creating a tag:

   ```bash
   npm version {version} --no-git-tag-version --allow-same-version \
     --workspaces --include-workspace-root
   ```

3. Edit Cargo and Tauri versions with `apply_patch`.
4. Run an unlocked Cargo check once to refresh only the local lock entry, then
   verify the lock:

   ```bash
   cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
   cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
   ```

5. Run `npm run test:ops` and confirm every file and lock entry equals the
   target.
6. Report the old and new versions. Do not commit or tag unless separately
   requested.
