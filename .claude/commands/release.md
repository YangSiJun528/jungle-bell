---
description: "Create a GitHub release with tag from the current version in Cargo.toml"
allowed-tools: Read, Bash, Edit, Grep, Skill, AskUserQuestion
---

Create a GitHub release. Follow the steps below in order.

**Important:** Always use the `AskUserQuestion` tool when asking the user a question. Never ask via plain text output.

## Step 1: Check local state

1. Verify the current branch is `main`.
2. Check for uncommitted changes (both unstaged and staged).
3. Check for unpushed commits.

If the branch is not `main` or there are uncommitted changes, **refuse the operation** and explain why.

If there are unpushed commits, use `AskUserQuestion` to ask whether to push them to the remote before proceeding. If the user agrees, run `git push origin main` and continue. If not, abort.

## Step 2: Check version and existing tags/releases

1. Read the current version from `src-tauri/Cargo.toml`.
2. The tag name follows the format `v{version}` (e.g., `v0.0.4-beta.2`).
3. Check if the tag already exists on the remote (`git ls-remote --tags origin`).
4. Check if a GitHub release already exists (`gh release view`).

If a tag or release already exists, use `AskUserQuestion` to present the user with these options:

1. **Abort** — the user resolves it manually and tries again
2. **Force deploy** — delete the existing release and tag, then recreate them
3. **Bump version and retry** — use `/bump-version` to increment to the next version, commit/push the changes, then restart from Step 1

## Step 3: Create and push tag

```
git tag v{version}
git push origin v{version}
```

## Step 4: Create GitHub release (draft)

The release is created as a **draft**. The CI workflow will automatically publish it after all builds complete.

```
gh release create v{version} --title "v{version}" --generate-notes --draft
```

- If the version contains prerelease identifiers (e.g., `-alpha`, `-beta`, `-rc`), use `AskUserQuestion` to ask the user whether to mark it as a **prerelease**.
  - If yes: add `--prerelease` flag (e.g., `--draft --prerelease`).
  - If no: use `--draft` as usual.

## Step 5: Trigger CI workflow

Trigger the release workflow manually via `workflow_dispatch`:

```
gh workflow run release.yml -f tag=v{version}
```

Wait 3 seconds, then get the workflow run URL:

```
sleep 3 && gh run list --workflow=release.yml --limit=1 --json url --jq '.[0].url'
```

## Step 6: Confirm

Inform the user that the release was created as a draft and the CI workflow has been triggered. Provide a link to the GitHub Actions workflow run. The release will be automatically published once all builds complete.
