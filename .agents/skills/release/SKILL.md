---
name: release
description: Prepare a Jungle Bell desktop release from the current version, trigger the release workflow, and provide its GitHub approval link. Use when the user asks to create a release, says "릴리즈 만들어줘", "release", or "/release".
---

# Release

Prepare a draft release and its builds. Final publication is approved by the user in GitHub Actions.

## Approval boundary

The release request authorizes preparing notes, the tag, the draft, and the workflow run.
Do not ask for separate changelog, prerelease-flag, or publication approval in chat.
Provide the exact workflow run link; the user approves the `desktop-release` environment there.
Never approve or bypass that environment, publish the draft yourself, or delete/recreate a published
release or tag. A failed guard is a blocker to report, not an invitation to force deployment.

## Step 1: Check local state

1. Verify the current branch is `main`.
2. Check for uncommitted changes (both unstaged and staged).
3. Check for unpushed commits.

If the branch is not `main` or there are uncommitted changes, **refuse the operation** and explain why.

Fetch `origin/main` and require HEAD to match it. If local and remote main differ, stop and report
the mismatch; do not push main or merge changes as part of this skill.

## Step 2: Check version and existing tags/releases

1. Read the current version from `desktop/Cargo.toml`.
2. The tag name follows the format `v{version}` (e.g., `v0.0.4-beta.2`).
3. Check if the tag already exists on the remote (`git ls-remote --tags origin`).
4. Check if a GitHub release already exists (`gh release view`).

Run `node scripts/verify-release-version.mjs v{version}` to check every package version.
An existing remote tag must resolve to the intended HEAD; never move it. An existing unpublished
draft for that same tag may be reused after checking its prerelease flag. An already published
release requires a new version through the normal version-bump PR process; stop without modifying it.
Treat authentication or network errors as errors, not as evidence that a release is absent.

## Step 3 (stable releases only): Draft changelog

Only run this step if the version has **no** prerelease identifiers (`-alpha`, `-beta`, `-rc`, etc.).

1. Find the highest previously published stable version in GitHub's release history.
   Exclude drafts and tags with prerelease identifiers; do not infer publication from Git tags alone.
   If this is the first stable release, use the repository history as the changelog source.

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

4. Write the Korean changelog to a temporary file and pass it with `--notes-file` in Step 5.
   The user can review or edit the draft before approving publication in GitHub; do not add a chat approval step.

## Step 4: Create and push tag

Create and push the tag only if it does not already exist. Reuse an existing matching tag.

```
git tag v{version}
git push origin v{version}
```

## Step 5: Create GitHub release (draft)

Create a **draft**, or reuse the matching unpublished draft from Step 2 without replacing its notes.
Publication requires successful checks and the user's `desktop-release` environment approval.

- **Prerelease/beta** (`-alpha.N`, `-beta.N`, `-rc.N`): `--prerelease` is mandatory and derived from the version.
  ```
  gh release create v{version} --verify-tag --title "v{version}" --generate-notes --draft --prerelease
  ```

- **Stable release**: use the changelog file from Step 3; omit `--prerelease`:
  ```
  gh release create v{version} --verify-tag --title "v{version}" --notes-file "{changelog_file}" --draft
  ```

## Step 6: Verify and trigger the release workflow

Run `GITHUB_REPOSITORY={owner/repo} node scripts/verify-release-policy.mjs v{version}`.
The pipeline also enforces this policy before building and after approval; agent checks do not replace it.
A stable release must exceed all published stable versions. A prerelease must exceed all published
stable versions and published prereleases with the same `X.Y.Z`. Newer unpublished drafts do not block retries.

Follow [release QA](../../../docs/template-release-qa.md) and the
[development guide](../../../CONTRIBUTING.md#ci와-릴리스-경계). Record the candidate SHA, results,
and untested scope outside the repository. Link the evidence from the draft when available;
do not claim unperformed checks passed. Checks requiring the built installers can finish before final approval.

Trigger the release workflow manually via `workflow_dispatch`:

```
gh workflow run release.yml --ref main -f tag=v{version}
```

Capture the dispatch start time and identify the new run by workflow, `workflow_dispatch` event,
main branch, intended main SHA, and display title `Desktop Release v{version}`. Use bounded retries
while the run appears. Do not take the newest run blindly or dispatch a duplicate after an uncertain response.

## Step 7: Provide the approval link

Return the exact GitHub Actions run link with a short Korean status, such as
"릴리스 빌드를 시작했습니다. 검증 후 이 실행에서 공개를 승인하면 됩니다."
Do not wait for or request a duplicate chat approval. If the run has already failed, report the failure;
if it is still building, do not describe it as already awaiting approval or published.
