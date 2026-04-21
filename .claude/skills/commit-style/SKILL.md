---
name: commit-style
description: jungle-bell 프로젝트의 git 커밋 메시지를 작성하고 커밋을 수행한다. 사용자가 "커밋해줘", "commit", "git commit" 등을 요청하거나 변경사항을 커밋해야 할 때 반드시 이 스킬을 사용해서 프로젝트 고유의 Conventional Commits + 한국어 subject 스타일을 따르도록 한다. 메시지 초안만 요청하는 경우에도 사용한다.
---

# jungle-bell 커밋 스타일

이 프로젝트는 **Conventional Commits** 형식을 쓰되 subject와 body를 **한국어**로 작성한다. 이 스킬의 목적은 `git log`가 보여주는 기존 패턴과 일관된 커밋을 만드는 것이다.

## 형식

```
<type>(<scope>): <subject 한국어>

<선택적 body 한국어, 왜(why)를 설명>
```

- 첫 줄은 `type(scope): subject` 한 줄. 마침표 없이 끝낸다.
- scope가 명확히 없으면 생략 가능 (`ci: ...`처럼).
- subject는 한국어 종결형 ("추가", "수정", "개선", "비활성화", "분리" 등 명사/동사형 마침).
- body는 **왜 변경했는지**를 설명. 단순 포맷팅·버전 bump·명백한 커밋이면 body 생략.

## type

기존 로그 빈도순:

- `feat` — 새 기능 추가
- `refactor` — 동작 동일, 구조 개선
- `fix` — 버그 수정
- `chore` — 빌드/릴리스/설정 등 비코드 잡일. 버전 bump는 항상 `chore(release)`
- `docs` — 문서만 변경
- `ci` — GitHub Actions/워크플로우

## scope

프로젝트에서 실제로 쓰이는 scope (새 scope 만들기 전에 재사용 가능한지 확인):

- `release` — 버전 bump, changelog, 릴리스 워크플로우
- `analytics` — PostHog 이벤트, 수집 로직
- `tray` — 시스템 트레이 메뉴/아이콘
- `updater` — 자동 업데이트
- `analyzer`, `webcrack`, `extractor` — `jungle-campus-analyzer/` 관련
- `checker` — 출석 체크 로직
- `rust`, `backend` — Rust/Tauri 백엔드 전반
- `notification` — OS 알림
- `ui`, `config` — 프론트엔드/설정

변경 파일 경로를 보고 가장 좁은 scope를 고른다. 애매하면 생략한다.

## subject 작성

- 한국어로 **무엇을 했는지** 30자 내외로.
- 기존 예시의 톤:
  - `개발 빌드에서 PostHog 이벤트 전송 비활성화`
  - `PostHog 이벤트에 OS 이름 프로퍼티 추가`
  - `트레이 메뉴에 버전/업데이트 상태 표시`
  - `Rust 백엔드 모듈 분리 및 버전 bump 0.2.2-beta.2`
- 영어 고유명사/식별자(PostHog, CI, OS, API 키 등)는 그대로 섞어 쓴다.
- `chore(release)` 버전 bump는 항상 `bump version to <X.Y.Z>` (이것만 영어 고정 문구).

## body 작성

body는 "왜 이 변경이 필요했는지"에 집중한다. 파일/함수 나열이 아니라 **배경·원인·효과**.

좋은 예:
```
`cfg!(debug_assertions)` 게이트를 추가해 `cargo tauri dev` 등 디버그 빌드에서는
이벤트가 전송되지 않도록 한다. 릴리스 빌드에서만 활성화되므로 개발 중 테스트
이벤트가 프로덕션 대시보드를 오염시키지 않는다.
```

변경이 여러 개면 `- ` 불릿으로 나열하되 각 항목도 **왜**를 포함:
```
- attendance_check_attempted → attendance_completed: 스케줄러 틱마다 발사하던 것을
  morning/evening 상태 전이 시에만 발사하도록 변경. ...
- PostHog 클라이언트 lazy 초기화로 변경하여 init() 직후 이벤트 유실 경쟁 상태 해소.
```

body 줄바꿈은 대략 80자 내외. 단순 bump/문구 수정이면 body 없음.

## 작업 흐름

사용자가 커밋을 요청하면:

1. **`git status`와 `git diff --staged`(또는 unstaged)로 변경사항을 확인**한다. 이미 메인 프롬프트에 상태가 있더라도 커밋 직전 상태를 다시 본다.
2. **최근 `git log --oneline -10`을 훑어** type/scope 패턴이 이번 변경에 맞게 이어지는지 확인한다.
3. **민감 파일(.env, credentials 등) 스테이징 여부 점검.** 섞여 있으면 사용자에게 경고.
4. **메시지 초안을 본문에 출력**한다. 애매한 scope·여러 종류의 변경이 섞인 경우 커밋을 나눌지도 함께 언급한다.
5. **`AskUserQuestion` 도구로 승인 루프를 연다.**

   `AskUserQuestion`은 자유 입력 전용 옵션을 만들 수 없고, 자유 텍스트는 항상 시스템이 자동 추가하는 **"기타(Other)"**로만 들어온다. 이 점을 이용해 한 번의 질문에 REPL 루프를 건다.

   질문 구성 (`header`: "커밋 승인", `multiSelect: false`):
   - `커밋` — 현재 초안 그대로 커밋 실행 → 6번으로
   - `취소` — 커밋하지 않고 종료
   - **(기타)** — 시스템이 자동으로 붙여주는 자유 입력. 사용자가 여기에 피드백을 적으면, 그 내용으로 초안을 수정한 뒤 **본문에 새 초안을 출력하고 같은 `AskUserQuestion`을 다시 호출**한다.

   `question`은 "이 메시지로 커밋할까요? 고칠 점이 있으면 '기타'에 피드백을 적어 주세요." 정도로, 사용자가 자유 입력 경로를 알 수 있게 안내한다. `커밋` 또는 `취소`가 선택될 때까지 반복.

6. `커밋`이 선택되면 아래 형식으로 실행:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body>
EOF
)"
```

HEREDOC을 써야 줄바꿈이 보존된다. body가 없으면 `git commit -m "<type>(<scope>): <subject>"` 한 줄로 충분.

7. 커밋 후 `git status`로 성공 확인.

## 하지 말 것

- `--amend`, `--no-verify`, `--no-gpg-sign`을 사용자의 명시적 요청 없이 쓰지 않는다.
- `git add -A` / `git add .` 남용 금지 — 변경된 파일을 이름으로 추가.
- 사용자가 "커밋해줘"라고만 했는데 임의로 push하지 않는다.
- type/scope를 새로 만들기 전에 기존 패턴 재사용 가능한지 먼저 본다.
- body에 "이 커밋은…", "이번 변경에서는…" 같은 불필요한 서문을 쓰지 않는다. 바로 본론.

## 예시

**단순 feat:**
```
feat(tray): 식단표 보러가기 메뉴 항목 추가
```

**why 설명이 필요한 fix:**
```
fix(analytics): PostHog API 키 하드코딩으로 CI 빌드에서 analytics 활성화

option_env!() 방식은 CI 환경변수 미설정 시 analytics가 비활성화되는 문제가 있었음.
Project API key는 공개 전제 설계이므로 소스에 직접 포함.
```

**버전 bump:**
```
chore(release): bump version to 0.2.6
```
