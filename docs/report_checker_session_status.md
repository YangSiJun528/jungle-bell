# checker 세션 상태 재현 리포트

문서 유형: explanation.

## 환경

- 날짜: 2026-07-07
- OS: macOS
- 앱: Jungle Bell `v0.3.7-beta.0`
- 작업 디렉터리: `/Users/sijun-yang/Documents/GitHub/jungle-bell`
- 로그 파일: `~/Library/Logs/dev.sijun-yang.jungle-bell/Jungle Bell.log`
- 우선 참고 문서: `docs/guide_checker_session_repro.md`
- git 상태: `docs/guide_checker_session_repro.md`가 기존 untracked 문서로 존재한다.

## 재현 절차

1. 앱을 종료한다.
2. macOS WebKit/HTTPStorages/Caches 세션 후보를 `/private/tmp` 아래 rollback 디렉터리로 이동해 세션 없음 상태를 만든다.
3. 앱을 실행하고 다음 로그 신호를 확인한다.
   - `[app] starting`
   - `web content process terminated`
   - `checker page loaded` 또는 `page loaded, triggering check`
   - `checker.js loaded`
   - `report: needs_login=...`
   - `trigger_check` 반복 여부
4. 앱을 종료한다.
5. `/private/tmp/jungle-bell-session-backups/session-20260707-230824.tgz` snapshot을 복구한다.
6. 앱을 다시 실행하고 같은 로그 신호를 확인한다.
7. 같은 세션 없음/세션 복구 흐름을 최소 2회 반복한다.

## 세션 snapshot 메타데이터

- archive: `/private/tmp/jungle-bell-session-backups/session-20260707-230824.tgz`
- size: `8.9M`
- mode: `600`
- entries: `954`
- sha256: `546a278db4e0334272fb8ba2ed8b5f36fd3231dbafa1ab5e72b4abc4f7b7e632`

세션 archive와 WebKit/HTTPStorages/Caches 파일 내용은 확인하거나 출력하지 않았다.

## 수정 전 관찰 결과

정식 반복 재현 root:

- `/private/tmp/jungle-bell-session-repro-20260707-233548`

보조 실행 root:

- `/private/tmp/jungle-bell-session-repro-20260707-233252`
- 이 실행은 스크립트 PATH 문제로 세션 이동이 실패했으므로 정식 세션 없음 재현으로 보지 않는다.

### 기준 정상 사례

2026-07-07 22:55:38 첫 실행 로그에서는 다음이 확인됐다.

- 앱 시작: `starting v0.3.7-beta.0`
- JS 초기화: `checker.js loaded, running initial check`
- 상태 보고: `report: needs_login=false morning=true evening=false`

이 경우 hidden checker WebView의 initialization script가 실행되고, Rust 커맨드 `report_attendance_status`까지 도달했다.

### 세션 없음 결과

2026-07-07 23:16:48 기존 실행과 2026-07-07 23:35:50, 23:36:59 정식 반복 실행에서 다음이 확인됐다.

- 앱 시작: `starting v0.3.7-beta.0`
- WebKit 프로세스 이벤트: `web content process terminated`
- checker page URL: `https://jungle-lms.krafton.com/login`
- `trigger_check`가 5초 간격으로 반복됨
- `checker.js loaded` 없음
- `report: needs_login=true` 없음

세션 제거는 `/login` URL 재현에는 성공했지만, 로그인 필요 상태가 Rust로 보고되지 않았다.

반복 결과:

| 회차 | 시작 시각 | checker URL | `checker.js loaded` | report | 결론 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-07-07 23:35:50 | `/login` | 없음 | 없음 | 재현 |
| 2 | 2026-07-07 23:36:59 | `/login` | 없음 | 없음 | 재현 |

### 세션 복구 결과

2026-07-07 23:18:09 기존 실행과 2026-07-07 23:36:25, 23:37:35 정식 반복 실행에서 다음이 확인됐다.

- 앱 시작: `starting v0.3.7-beta.0`
- WebKit 프로세스 이벤트: `web content process terminated`
- checker page URL: `https://jungle-lms.krafton.com/check-in`
- `trigger_check`가 5초 간격으로 반복됨
- `checker.js loaded` 없음
- `report: needs_login=false` 없음

세션 snapshot 복구는 `/check-in` URL까지 도달하게 했지만, hidden checker WebView의 상태 보고는 복구하지 못했다.

반복 결과:

| 회차 | 시작 시각 | checker URL | `checker.js loaded` | report | 결론 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-07-07 23:36:25 | `/check-in` | 없음 | 없음 | 재현 |
| 2 | 2026-07-07 23:37:35 | `/check-in` | 없음 | 없음 | 재현 |

### 트레이 아이콘 상태

수정 전 코드에서 트레이 아이콘은 `setup_tray()` 시점에 `ICON_WARNING`으로 생성된다. 위 네 번의 정식 재현 모두 `data_loaded=false`가 유지되어 `update_tray()`가 호출될 수 있는 report가 없었다. 따라서 트레이 아이콘은 초기 warning 상태에서 벗어날 신호가 없다.

## 기대 동작

- 세션 없음 상태에서는 시작 후 일정 시간 안에 `checker.js loaded`와 `report: needs_login=true`가 기록되어야 한다.
- 세션 복구 상태에서는 시작 후 일정 시간 안에 `checker.js loaded`와 `report: needs_login=false`가 기록되어야 한다.
- 첫 report 전에는 트레이 아이콘이 로그인 필요 상태로 확정 표시되지 않아야 한다.
- checker WebView가 page-load 후 report를 보내지 못하면 단순 `trigger_check` 반복이 아니라 WebView 복구가 수행되어야 한다.

## 실제 동작

- hidden checker WebView의 URL 전환은 세션 상태를 반영한다.
- 하지만 `checker.js loaded`와 `report_attendance_status`가 누락되는 실행이 있다.
- 이 상태에서는 scheduler가 `trigger_check`를 반복하지만 이벤트 listener가 등록되지 않았으므로 상태가 갱신되지 않는다.
- 트레이 아이콘은 시작 시 `ICON_WARNING`으로 설정되어 첫 report가 없으면 노란색으로 남을 수 있다.

## 가장 가능성 높은 원인

hidden checker WebView의 initialization script가 특정 실행에서 실행되지 않거나, 실행 전에 WebKit content process가 종료되어 JS event listener와 Tauri invoke 경로가 구성되지 않는 것이 가장 가능성이 높다.

현재 구현은 첫 report 부재를 별도 상태로 추적하지 않고, `trigger_check` 반복만 수행한다. 따라서 JS가 로드되지 않은 경우 복구 경로가 없다.

## 아직 확인되지 않은 가설

- macOS `ActivationPolicy::Accessory` 및 Dock 숨김 시점이 hidden checker WebView 초기화와 충돌하는지 여부
- `visible(false)` hidden WebView에서 WebKit content process 종료 후 initialization script가 재주입되지 않는지 여부
- checker WebView reload만으로 충분한지, destroy 후 재생성이 필요한지 여부
- 첫 report 전 트레이 warning icon이 사용자에게 로그인 필요 상태로 오해되는 정도

## 개선 검증 결과

### 적용한 수정

- checker page-load 세대, checker.js ready 세대, report 세대를 `AppState`에 추가했다.
- `checker.js` 로드 시 `report_checker_ready` 커맨드를 호출해 initialization script 실행 여부를 Rust에서 추적한다.
- `report_attendance_status` 수신 시 현재 checker 세대를 report 완료로 표시하고 no-report 재생성 카운터를 리셋한다.
- checker page-load 후 7초 안에 해당 세대의 report가 없으면 watchdog이 checker WebView를 `destroy()` 후 재생성한다.
- watchdog 재생성은 연속 3회까지 수행하고, 이후에는 오류 로그로 중단한다.
- macOS Dock/ActivationPolicy 숨김 동기화를 `build_checker_window()` 직후가 아니라 첫 checker report 이후로 늦췄다.
- 첫 report 전 트레이 아이콘을 warning orange가 아닌 default white icon과 `로딩 중...` tooltip으로 시작하게 했다.

### 자동 테스트 결과

- `cargo fmt --check`: 통과
- `cargo clippy --locked -- -D warnings`: 통과
- `cargo test --locked`: 통과
  - `112 passed`
  - 추가된 checker watchdog 순수 로직 테스트 포함
- `cargo build --locked`: 통과
  - 수동 검증용 debug binary 갱신 목적

### 수정 후 수동 테스트

정식 반복 검증 root:

- `/private/tmp/jungle-bell-session-repro-20260707-234328`

세션 없음 결과:

| 회차 | 시작 시각 | checker URL | `checker.js loaded` | report | watchdog |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-07-07 23:43:32 | `/login` | 있음 | `needs_login=true` | 미발동 |
| 2 | 2026-07-07 23:44:40 | `/login` | 있음 | `needs_login=true` | 미발동 |

세션 복구 결과:

| 회차 | 시작 시각 | checker URL | `checker.js loaded` | report | watchdog |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-07-07 23:44:05 | `/check-in` | 있음 | `needs_login=false` | 미발동 |
| 2 | 2026-07-07 23:45:15 | `/check-in` | 있음 | `needs_login=false` | 미발동 |

세션 없음 상태에서는 `checker.js loaded`, `checker.js ready`, `report: needs_login=true`가 시작 직후 기록됐다.

세션 복구 상태에서는 `checker.js loaded`, `checker.js ready`, `report: needs_login=false morning=true evening=false`가 시작 직후 기록됐다.

### 수정 전/후 로그 차이

수정 전 세션 없음:

- `/login` page-load 확인
- `trigger_check` 5초 반복
- `checker.js loaded` 없음
- `report: needs_login=true` 없음
- `data_loaded=false` 유지

수정 후 세션 없음:

- `/login` page-load 확인
- `checker.js loaded, running initial check`
- `checker.js ready`
- `report: needs_login=true`
- `data_loaded=true`로 전환

수정 전 세션 복구:

- `/check-in` page-load 확인
- `trigger_check` 5초 반복
- `checker.js loaded` 없음
- `report: needs_login=false` 없음
- `data_loaded=false` 유지

수정 후 세션 복구:

- `/check-in` page-load 확인
- `checker.js loaded, running initial check`
- `checker.js ready`
- `report: needs_login=false morning=true evening=false`
- `data_loaded=true`로 전환

### 트레이 아이콘 개선

- 수정 전에는 `setup_tray()`가 초기 아이콘을 warning orange로 생성했다. 첫 report가 없으면 노란 아이콘이 stale 상태로 남았다.
- 수정 후에는 초기 아이콘이 default white이고 tooltip이 `Jungle Bell - 로딩 중...`이다.
- 세션 없음 수동 검증에서는 report가 도착한 뒤 로그인 필요 상태로 전환된다.
- 세션 복구 수동 검증에서는 report가 도착한 뒤 실제 출석 phase 기반 아이콘으로 전환된다.

### 남은 리스크

- 이번 수동 검증에서는 watchdog 재생성이 실제로 발동하지 않았다. no-report 판단과 stale watchdog 무시는 단위 테스트로 검증했지만, WebView `destroy()` 후 재생성 통합 경로는 실제 no-report 장애를 강제로 주입해 검증하지 못했다.
- 가장 유력한 원인은 첫 report 전 macOS `ActivationPolicy::Accessory` 전환이 hidden checker 초기화에 영향을 준다는 가설이지만, WebKit 내부 원인은 확정하지 못했다.
- `checker.js ready`가 page-load 세대 증가보다 먼저 도착할 수 있다. 실제 report는 page-load 후 trigger에서도 다시 들어오므로 현재 동작에는 문제가 없지만, ready 세대 로그 해석 시 이 순서를 고려해야 한다.
- 세션 archive와 live WebKit storage는 인증 정보를 포함할 수 있으므로 `/private/tmp`의 재현/검증 디렉터리는 외부 공유 금지다.

### 후속 개선 후보

- no-report 상태를 강제로 만드는 테스트 전용 flag를 추가해 watchdog의 WebView destroy/recreate 통합 경로를 재현한다.
- checker ready/report 이벤트에 page-load generation을 JS에서 직접 전달하도록 보강해 세대 로그를 더 정확하게 만든다.
- watchdog give-up 이후 사용자에게 상태 확인 실패를 별도 메뉴 텍스트로 표시한다.
