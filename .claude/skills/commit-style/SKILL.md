---
name: commit-style
description: Writes git commit messages and performs commits for the jungle-bell project. Use this skill whenever the user says "커밋해줘", "commit", "git commit", or otherwise asks to commit changes, so the project's Conventional Commits + Korean-subject style is followed. Also use it when the user only wants a draft message.
---

# jungle-bell commit style

This project uses **Conventional Commits** with the subject and body written in **Korean**. The goal of this skill is to produce commits consistent with the existing patterns visible in `git log`.

## Format

```
<type>(<scope>): <Korean subject>

<optional Korean body, explaining the "why">
```

- The first line is a single `type(scope): subject`. No trailing period.
- Omit the scope when none clearly applies (e.g. `ci: ...`).
- Subjects end in Korean noun/verb forms ("추가", "수정", "개선", "비활성화", "분리", etc.).
- The body explains **why** the change was made. Skip it for trivial changes (formatting, version bumps, obvious commits).

## type

In order of frequency in the existing log:

- `feat` — new feature
- `refactor` — behavior unchanged, structure improved
- `fix` — bug fix
- `chore` — build/release/config chores. Version bumps are always `chore(release)`
- `docs` — documentation-only changes
- `ci` — GitHub Actions / workflows

## scope

Scopes actually used in the project (check if an existing one fits before inventing a new scope):

- `release` — version bumps, changelog, release workflows
- `analytics` — PostHog events, collection logic
- `tray` — system tray menu/icon
- `updater` — auto updater
- `analyzer`, `webcrack`, `extractor` — related to `jungle-campus-analyzer/`
- `checker` — attendance check logic
- `rust`, `backend` — Rust/Tauri backend in general
- `notification` — OS notifications
- `ui`, `config` — frontend / configuration

Pick the narrowest scope that matches the changed paths. Omit when ambiguous.

## Writing the subject

- Around 30 Korean characters, stating **what** was done.
- Tone matches existing examples:
  - `개발 빌드에서 PostHog 이벤트 전송 비활성화`
  - `PostHog 이벤트에 OS 이름 프로퍼티 추가`
  - `트레이 메뉴에 버전/업데이트 상태 표시`
  - `Rust 백엔드 모듈 분리 및 버전 bump 0.2.2-beta.2`
- Keep English proper nouns/identifiers (PostHog, CI, OS, API 키, etc.) inline as-is.
- For `chore(release)` version bumps the subject is always the fixed English phrase `bump version to <X.Y.Z>`.

## Writing the body

The body focuses on **why the change was needed** — background, cause, effect — not an enumeration of files/functions.

Good example:
```
`cfg!(debug_assertions)` 게이트를 추가해 `cargo tauri dev` 등 디버그 빌드에서는
이벤트가 전송되지 않도록 한다. 릴리스 빌드에서만 활성화되므로 개발 중 테스트
이벤트가 프로덕션 대시보드를 오염시키지 않는다.
```

When there are multiple changes, list them as `- ` bullets, still explaining **why** per item:
```
- attendance_check_attempted → attendance_completed: 스케줄러 틱마다 발사하던 것을
  morning/evening 상태 전이 시에만 발사하도록 변경. ...
- PostHog 클라이언트 lazy 초기화로 변경하여 init() 직후 이벤트 유실 경쟁 상태 해소.
```

Wrap body lines around 80 characters. For simple bumps/trivial wording changes, no body.

## Workflow

When the user requests a commit:

1. **Inspect the changes** with `git status` and `git diff --staged` (or unstaged). Re-check even if the prompt already shows status — look at the state right before committing.
2. **Skim recent `git log --oneline -10`** to confirm the type/scope pattern fits this change.
3. **Check for sensitive files** (.env, credentials, etc.) in staging. Warn the user if any are mixed in.
4. **Print the draft message in the response body.** If the scope is ambiguous or multiple kinds of change are mixed, mention that splitting the commit might be better.
5. **Open the approval loop with the `AskUserQuestion` tool.**

   `AskUserQuestion` cannot define a free-text-only option; free text always arrives via the auto-appended **"Other" (기타)** choice. Exploit that to implement a REPL-style loop in a single question.

   Question setup (`header`: "커밋 승인", `multiSelect: false`):
   - `커밋` — commit with the current draft as-is → go to step 6
   - `취소` — abort without committing
   - **(기타)** — free-text input auto-added by the system. If the user enters feedback here, revise the draft accordingly, **print the new draft in the response body, and call the same `AskUserQuestion` again**.

   Use a `question` like "이 메시지로 커밋할까요? 고칠 점이 있으면 'Type something'에 피드백을 적어 주세요." so the user knows the free-text path exists. Loop until `커밋` or `취소` is selected.

6. If `커밋` is selected, run:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body>
EOF
)"
```

The HEREDOC preserves newlines. If there is no body, a single-line `git commit -m "<type>(<scope>): <subject>"` is enough.

7. Confirm success with `git status` afterward.

## Don't

- Do not use `--amend`, `--no-verify`, or `--no-gpg-sign` unless the user explicitly asks.
- Avoid `git add -A` / `git add .` — stage changed files by name.
- Do not push on your own when the user only said "커밋해줘".
- Before inventing a new type/scope, check whether an existing one applies.
- No throat-clearing prefaces in the body like "이 커밋은…" or "이번 변경에서는…" — get straight to the point.

## Examples

**Simple feat:**
```
feat(tray): 식단표 보러가기 메뉴 항목 추가
```

**Fix needing a "why":**
```
fix(analytics): PostHog API 키 하드코딩으로 CI 빌드에서 analytics 활성화

option_env!() 방식은 CI 환경변수 미설정 시 analytics가 비활성화되는 문제가 있었음.
Project API key는 공개 전제 설계이므로 소스에 직접 포함.
```

**Version bump:**
```
chore(release): bump version to 0.2.6
```
