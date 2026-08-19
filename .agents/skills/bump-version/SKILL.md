---
name: bump-version
description: Set one stable release version across the Jungle Bell Gradle server, Vite frontend, and Tauri desktop app. Use when the user asks to bump or align versions, says "버전 올려줘", "bump version", or "/bump-version", or when server/build.gradle.kts, frontend package metadata, desktop Cargo metadata, and tauri.conf.json have drifted.
---

# Bump version

Apply one stable SemVer such as `0.5.0` to every first-party release surface. Never append
`-SNAPSHOT`.

The Vite application version is the top-level package version. Do not change the `vite`, Spring
Boot, Tauri crate, or other dependency versions as part of an application version bump.

Update these release surfaces together:

1. `frontend/package.json` — top-level `"version"` field
2. `frontend/package-lock.json` — root and `packages[""]` versions
3. `server/build.gradle.kts` — `allprojects` version
4. `desktop/Cargo.toml` — `[package]` version
5. `desktop/tauri.conf.json` — top-level `"version"` field
6. `desktop/Cargo.lock` — `jungle-bell` package version

## Steps

1. Read all six files and record their current first-party versions.
2. If the user did not provide a target, ask one concise question showing the current versions.
3. Reject targets that are not plain `MAJOR.MINOR.PATCH` SemVer.
4. In `frontend/`, run
   `npm version <version> --no-git-tag-version --allow-same-version`.
5. Update `server/build.gradle.kts`, `desktop/Cargo.toml`, and
   `desktop/tauri.conf.json` with `apply_patch`.
6. In `desktop/`, run `cargo generate-lockfile`.
7. From `frontend/`, run
   `npm test -- src/tests/contracts/release-channel.test.ts`.
8. Confirm every release surface has the target version and report each old-to-new change.
