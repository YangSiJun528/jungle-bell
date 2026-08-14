---
name: bump-version
description: Bump the app version across all config files for the jungle-bell project. Use when the user asks to bump/update the version, or says "버전 올려줘", "bump version", "/bump-version". Updates frontend/package.json, frontend/package-lock.json, desktop/Cargo.toml, desktop/tauri.conf.json, and desktop/Cargo.lock.
---

# Bump version

Bump the version of this project.

If the user provided a specific version as an argument, use that version. Otherwise, read the current versions from `frontend/package.json`, `desktop/Cargo.toml`, and `desktop/tauri.conf.json` first, then ask the user what version they want to bump to.

The following files need to be updated:

1. `frontend/package.json` — top-level `"version"` field
2. `frontend/package-lock.json` — updated with `npm version <version> --no-git-tag-version --allow-same-version`
3. `desktop/Cargo.toml` — `version` field in `[package]`
4. `desktop/tauri.conf.json` — top-level `"version"` field
5. `desktop/Cargo.lock` — updated with `cargo generate-lockfile`

## Interaction compatibility

If a required target version is missing, ask one concise question and wait for the user's answer. Use the structured user-input tool available in the current runtime:

- In runtimes that provide `AskUserQuestion`, use `AskUserQuestion`.
- In Codex, use Codex's available user-input mechanism when available and appropriate; otherwise ask in normal chat.

## Steps

1. Read `frontend/package.json`, `desktop/Cargo.toml`, and `desktop/tauri.conf.json` to confirm their current versions
2. If no target version was specified, ask the user which version to bump to (show the current version for reference)
3. Run `npm version <version> --no-git-tag-version --allow-same-version` in `frontend/` to update `package.json` and `package-lock.json`
4. Update the version string in `desktop/Cargo.toml` and `desktop/tauri.conf.json`
5. Run `cargo generate-lockfile` in `desktop/` to update `Cargo.lock`
6. Confirm all five files contain the target version and report the old and new versions to the user
