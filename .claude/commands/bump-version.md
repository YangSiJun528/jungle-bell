---
description: "Bump the app version across all config files"
allowed-tools: Read, Edit, Grep, Bash, AskUserQuestion
---

Bump the version of this project.

If the user provided a specific version via `$ARGUMENTS`, use that version. If `$ARGUMENTS` is empty or not a valid version string, read the current version from `src-tauri/Cargo.toml` first, then ask the user what version they want to bump to.

The following files need to be updated:

1. `src-tauri/Cargo.toml` — `version` field in `[package]`
2. `src-tauri/tauri.conf.json` — `"version"` field at the top level
3. `src-tauri/Cargo.lock` — `version` field for the `jungle-bell` package

**Important:** Always use the `AskUserQuestion` tool when asking the user a question. Never ask via plain text output.

Steps:
1. Read both config files to confirm current version
2. If no target version was specified, ask the user which version to bump to (show the current version for reference)
3. Update the version string in both config files
4. Run `cargo generate-lockfile` in `src-tauri/` to update Cargo.lock
5. Report the old version and new version to the user
