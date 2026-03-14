---
description: "Bump the app version across all config files"
allowed-tools: Read, Edit, Grep, Bash
---

Bump the version of this project to the version specified by the user: $ARGUMENTS

The following files need to be updated:

1. `src-tauri/Cargo.toml` — `version` field in `[package]`
2. `src-tauri/tauri.conf.json` — `"version"` field at the top level
3. `src-tauri/Cargo.lock` — `version` field for the `jungle-bell` package

Steps:
1. Read both config files to confirm current version
2. Update the version string in both config files
3. Run `cargo generate-lockfile` in `src-tauri/` to update Cargo.lock
4. Report the old version and new version to the user