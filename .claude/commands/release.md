---
description: "Create a GitHub release with tag from the current version in Cargo.toml"
allowed-tools: Read, Bash, Edit, Grep, Skill, AskUserQuestion
---

Create a GitHub release. Follow the steps below in order.

## Step 1: Check local state

1. Verify the current branch is `main`.
2. Check for uncommitted changes (both unstaged and staged).
3. Check for unpushed commits.

If any of the above apply, **refuse the operation** and explain why. Ask the user to resolve the issues and try again.

## Step 2: Check version and existing tags/releases

1. Read the current version from `src-tauri/Cargo.toml`.
2. The tag name follows the format `v{version}` (e.g., `v0.0.4-beta.2`).
3. Check if the tag already exists on the remote (`git ls-remote --tags origin`).
4. Check if a GitHub release already exists (`gh release view`).

If a tag or release already exists, present the user with these options:

1. **Abort** — the user resolves it manually and tries again
2. **Force deploy** — delete the existing release and tag, then recreate them
3. **Bump version and retry** — use `/bump-version` to increment to the next version, commit/push the changes, then restart from Step 1

## Step 3: Create and push tag

```
git tag v{version}
git push origin v{version}
```

## Step 4: Create GitHub release

```
gh release create v{version} --title "v{version}" --generate-notes --latest
```

- Even if the version contains prerelease identifiers like `alpha`, `beta`, or `rc`, do **not** mark it as a prerelease. Always use `--latest` to set it as the latest release.

## Step 5: Report result

Show the created release URL to the user.
