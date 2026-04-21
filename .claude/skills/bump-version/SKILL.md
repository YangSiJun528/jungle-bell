---
name: bump-version
description: Bump the app version across all config files for the jungle-bell project. Use when the user asks to bump/update the version, or says "버전 올려줘", "bump version", "/bump-version". Updates src-tauri/Cargo.toml, src-tauri/tauri.conf.json, and regenerates Cargo.lock.
---

# Bump version

Bump the version of this project.

If the user provided a specific version as an argument, use that version. Otherwise, read the current version from `src-tauri/Cargo.toml` first, then ask the user what version they want to bump to.

The following files need to be updated:

1. `src-tauri/Cargo.toml` — `version` field in `[package]`
2. `src-tauri/tauri.conf.json` — `"version"` field at the top level
3. `src-tauri/Cargo.lock` — updated via `cargo generate-lockfile`

**Important:** Always use the `AskUserQuestion` tool when asking the user a question. Never ask via plain text output.

## Steps

1. Read both config files to confirm current version
2. If no target version was specified, ask the user which version to bump to (show the current version for reference)
3. Update the version string in both config files
4. Run `cargo generate-lockfile` in `src-tauri/` to update Cargo.lock
5. Report the old version and new version to the user
