---
description: "Bump the app version across all config files"
allowed-tools: Read, Edit, Grep
---

Bump the version of this project to the version specified by the user: $ARGUMENTS

The following files need to be updated:

1. `src-tauri/Cargo.toml` — `version` field in `[package]`
2. `src-tauri/tauri.conf.json` — `"version"` field at the top level

Steps:
1. Read both files to confirm current version
2. Update the version string in both files
3. Report the old version and new version to the user
