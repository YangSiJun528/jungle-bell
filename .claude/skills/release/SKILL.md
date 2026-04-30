---
name: release
description: Create a GitHub release with a tag from the current version in src-tauri/Cargo.toml. Use when the user asks to create a release, says "릴리즈 만들어줘", "release", "/release", or otherwise wants to publish a new version. Handles branch/state checks, changelog drafting (Korean), tag push, draft release creation, and CI workflow trigger.
---

# Release

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
3. **Bump version and retry** — use the `bump-version` skill to increment to the next version, commit/push the changes, then restart from Step 1

## Step 3 (stable releases only): Review changelog and get user approval

Only run this step if the version has **no** prerelease identifiers (`-alpha`, `-beta`, `-rc`, etc.).

1. Find the previous stable release tag (exclude prerelease/beta tags):
   ```
   git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -2
   ```
   If the current version tag already exists, the second result is the previous version; otherwise the first result is.

2. Get the commit list from the previous stable tag to HEAD:
   ```
   git log {prev_tag}..HEAD --oneline --no-merges
   ```

3. Write a human-readable changelog **in Korean**, describing the **net difference** a user upgrading from the previous stable version will experience. The commit log between the two stable tags is just source material — do **not** narrate the development history.

   **Frame the changelog from the previous-stable user's perspective.** Ignore intermediate beta churn:
   - If a feature was introduced in beta-1 and iterated/refactored across later betas, describe only the **final shape** that ships in this release.
   - If a change was introduced in beta and later reverted before this release, omit it entirely.
   - A bug fix that only affected a beta build (the bug never reached the previous stable version) is **not** user-facing — exclude it.
   - A migration/compatibility fix added during beta to handle upgrades from the previous stable is part of the upgrade experience and may be omitted (silent migrations) or briefly noted if user-visible.
   - Default-value changes apply to new installs only; mention this nuance if relevant.
   - Pure internal refactors, doc-only commits, and CI/release-tooling changes generally do **not** belong in user-facing notes unless they produce a visible behavior change.

   Group the surviving items as:
   - **새 기능** — user-visible feature additions (final shape only)
   - **버그 수정** — fixes for issues that existed in the previous stable version
   - **기타** — remaining user-relevant changes (e.g., default value changes, deprecations)

   Each item is one concise Korean line. Bold a short label at the start when it helps scanning.

4. Use `AskUserQuestion` to present the drafted changelog **in Korean** and ask (in Korean) whether to proceed. If the user wants edits, apply them. If they decline, abort.

5. Use the user-approved changelog with `--notes` in Step 5 (instead of `--generate-notes`).

## Step 4: Create and push tag

```
git tag v{version}
git push origin v{version}
```

## Step 5: Create GitHub release (draft)

The release is created as a **draft**. The CI workflow will automatically publish it after all builds complete.

- **Prerelease/beta** (version contains `-alpha`, `-beta`, `-rc`, etc.): use `--generate-notes`. Ask via `AskUserQuestion` (in Korean) whether to add the `--prerelease` flag.
  ```
  gh release create v{version} --title "v{version}" --generate-notes --draft [--prerelease]
  ```

- **Stable release**: use the user-approved changelog from Step 3 via `--notes` (do not use `--generate-notes`):
  ```
  gh release create v{version} --title "v{version}" --notes "{changelog}" --draft
  ```

## Step 6: Trigger CI workflow

Trigger the release workflow manually via `workflow_dispatch`:

```
gh workflow run release.yml -f tag=v{version}
```

Wait 3 seconds, then get the workflow run URL:

```
sleep 3 && gh run list --workflow=release.yml --limit=1 --json url --jq '.[0].url'
```

## Step 7: Confirm

Inform the user that the release was created as a draft and the CI workflow has been triggered. Provide a link to the GitHub Actions workflow run. The release will be automatically published once all builds complete.
