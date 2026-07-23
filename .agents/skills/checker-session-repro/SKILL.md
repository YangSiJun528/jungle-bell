---
name: checker-session-repro
description: jungle-bell hidden checker WebView를 사용자 수동 로그인/로그아웃 없이 세션 파일 백업/제거/복구로 로그인 없음 상태와 세션 복구 상태를 반복 재현하고 검증한다. checker.js ready/report, 세션 백업/복구, stale tray icon, watchdog refresh/give-up, checker 세션 재현 리포트 작성이 필요할 때 사용한다.
---

# Checker Session Repro

이 스킬은 jungle-bell의 hidden checker WebView를 세션 상태별로 재현/검증할 때 사용한다. 목표는 사용자가 매번 로그인/로그아웃하지 않아도 되도록 WebKit 세션 파일을 백업, 제거, 복구해서 로그인 없음 상태를 반복 재현하는 것이다.

긴 재현 플로우는 `references/session-repro-guide.md`에 번들되어 있다. 세션 백업/복구나 실제 재현을 수행할 때는 이 reference를 먼저 읽고 따른다.

- 이전 검증 결과와 환경 차이가 필요하면 `references/session-status-report.md`를 읽는다.
- 공개 앱의 ready/timeout 복구 패턴이 필요하면 `references/webview-patterns.md`를 읽는다.

## 기본 원칙

- 먼저 `references/session-repro-guide.md`를 읽고 절차를 따른다.
- 반복 실험은 세션 파일 백업/제거/복구로 수행한다. 사용자의 수동 로그인/로그아웃에 의존하지 않는다.
- logged-in snapshot이 전혀 없을 때만 사용자에게 한 번 로그인된 상태를 준비하도록 요청하고, 이후 반복 작업은 snapshot으로 수행한다.
- 세션, 쿠키, WebKit storage, `binarycookies` 내용은 절대 출력하지 않는다.
- 문서/최종 답변에는 파일명, 경로, 크기, 해시, 존재 여부 같은 메타데이터만 기록한다.
- `/private/tmp` 아래에 작업 디렉터리를 만들고 세션 백업/복구 파일을 둔다.
- `/private/tmp`의 백업 파일은 절대 git에 추가하지 않는다.
- 기존 사용자 변경사항을 되돌리지 않는다.
- 앱 실행 로그에 API 응답 body, 내부 ID, 사용자 ID가 나오면 그대로 인용하지 말고 필요한 신호만 요약한다.
- GUI 앱 실행, 세션 파일 이동, 앱 종료가 필요하면 필요한 권한 상승을 요청한다.

## 작업 순서

1. 상태 확인:
   - `git status --short`로 기존 변경사항을 기록한다.
   - `references/session-repro-guide.md`를 읽고, 필요할 때만 관련 reference를 추가로 읽는다.
   - 현재 코드에서 checker/tray 관련 파일을 찾는다: `src-tauri/src/checker.rs`, `commands.rs`, `lib.rs`, `tray.rs`, `state.rs`, `src/checker.js`.

2. 재현 root 생성:
   - 예: `/private/tmp/jungle-bell-session-repro-YYYYMMDD-HHMMSS`
   - 하위에 `logs/`, `session-backups/`, `notes/`를 둘 수 있다.
   - 세션 파일 내용은 복사만 하고 열람하지 않는다.

3. 세션 백업:
   - 앱을 먼저 종료한다.
   - 가이드 문서의 live WebKit/session 경로를 기준으로 백업한다.
   - 백업 후 기록 가능한 항목은 경로, 파일 수, 총 크기, 해시뿐이다.
   - `cat`, `strings`, SQLite dump, cookie dump, WebKit storage dump를 하지 않는다.

4. 테스트 케이스 실행:
   - **세션 없음**: live session 파일을 rollback 위치로 이동해 로그인 없음 상태로 실행한다.
   - **세션 복구**: 백업한 session snapshot을 복구한 상태로 실행한다.
   - **현재 live session**: 사용자가 명시하거나 세션 전환이 위험하면 현재 상태만 실행한다.
   - 각 케이스는 가능하면 2회 반복한다.

5. 앱 실행:
   - 기본 명령: `RUST_LOG=info cargo tauri dev`
   - 실행 후 충분한 로그를 수집하고 종료한다.
   - 실행 중 다음 신호를 찾는다:
     - `app starting`
     - `web content process terminated`
     - `checker page loaded` 또는 `page loaded, triggering check`
     - `checker.js loaded`
     - `checker.js ready`
     - `report: needs_login=true|false`
     - `trigger_check emitted`
     - watchdog `Refresh`/`GiveUp`
     - tray 상태가 loading/offline/login/action/normal 중 어디로 전이됐는지

6. 기대 결과 판정:
   - 세션 없음 정상:
     - `/login` 또는 로그인 필요 경로 확인
     - `checker.js loaded`
     - `checker.js ready`
     - `report: needs_login=true`
     - 첫 report 전에는 gray/loading, report 후에는 login warning
   - 세션 복구 정상:
     - `/check-in` 확인
     - `checker.js loaded`
     - `checker.js ready`
     - `report: needs_login=false`
     - report 후 실제 출석 phase 기반 tray 상태
   - no-report 장애:
     - page-load와 `trigger_check`는 있지만 `checker.js loaded` 또는 report가 없다.
     - timeout 후 watchdog refresh가 발생해야 한다.
     - refresh 한도 초과 시 gray/offline 상태가 남아야 한다.

7. 리포트 작성:
   - 사용자가 별도 파일을 지정하지 않으면 `references/session-status-report.md`에 후속 검증 섹션을 추가한다.
   - 포함할 항목:
     - 날짜/환경
     - 테스트 케이스
     - 실행 명령
     - 관찰 신호
     - 기대 동작
     - 실제 동작
     - 수정 전/후 차이
     - 남은 리스크
   - 민감 정보는 요약하지 말고 제거한다. 내부 ID도 기록하지 않는다.

## 로그 요약 규칙

원본 로그를 그대로 붙이지 말고 다음 형태로 요약한다.

```text
2026-07-08 01:13:51 KST app starting
2026-07-08 01:13:53 KST checker.js loaded
2026-07-08 01:13:53 KST checker.js ready: generation=0
2026-07-08 01:13:53 KST page loaded: /check-in generation=1
2026-07-08 01:13:53 KST report: needs_login=false morning=true evening=false
2026-07-08 01:14:56 KST periodic trigger_check -> report received
```

다음은 기록하지 않는다.

- cookie 값
- `binarycookies` 내용
- WebKit storage content
- API raw response body
- 사용자 ID, cohort ID, attendance ID 같은 내부 식별자
- Authorization, Set-Cookie, CSRF token

## 세션 복구 후 정리

- 테스트가 끝나면 앱을 종료한다.
- live session 상태를 변경했다면 가이드 절차대로 원래 상태로 복구한다.
- `/private/tmp` 백업은 git 밖에 남겨도 되지만, 최종 답변에 위치와 민감성만 알린다.
- `git status --short`로 workspace에 세션 파일이 섞이지 않았는지 확인한다.

## 자동 검증

코드를 수정했다면 최소한 다음을 실행한다.

```bash
cargo fmt --check
cargo clippy --locked -- -D warnings
cargo test --locked
```

앱 실행 검증과 자동 검증은 구분해서 보고한다. `cargo test`가 통과해도 WebView/session 문제를 검증한 것은 아니다.
