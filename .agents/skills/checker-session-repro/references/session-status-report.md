# checker 세션 상태 누적 재현 리포트

문서 유형: explanation.

## 환경

- 날짜: 2026-07-07
- OS: macOS
- 앱: Jungle Bell `v0.3.7-beta.0`
- 작업 디렉터리: `/Users/sijun-yang/Documents/GitHub/jungle-bell`
- 로그 파일: `~/Library/Logs/dev.sijun-yang.jungle-bell/Jungle Bell.log`
- 우선 참고 절차: `.agents/skills/checker-session-repro/references/session-repro-guide.md`

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
- 당시 수정에서는 첫 report 전 트레이 아이콘을 warning orange가 아닌 default white icon과 `로딩 중...` tooltip으로 시작하게 했다.
- 후속 수정에서는 상태 미확인/오프라인 표현을 흰색 정상 아이콘과 분리하기 위해 별도 gray icon과 `상태 확인 중...`/`상태 확인 불가` 상태를 추가했다.

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
- 당시 수정 후에는 초기 아이콘이 default white이고 tooltip이 `Jungle Bell - 로딩 중...`이었다.
- 후속 수정 후에는 초기/복구중/확인불가 상태가 gray icon으로 표시되고 tooltip은 `Jungle Bell - 상태 확인 중...`, `Jungle Bell - 상태 재확인 중...`, `Jungle Bell - 상태 확인 불가` 중 하나가 된다.
- 세션 없음 수동 검증에서는 report가 도착한 뒤 로그인 필요 상태로 전환된다.
- 세션 복구 수동 검증에서는 report가 도착한 뒤 실제 출석 phase 기반 아이콘으로 전환된다.

### 후속 실제 앱 실행 검증

검증 시각:

- 2026-07-08 01:13:51 KST 시작
- 2026-07-08 01:14:56 KST 주기 재확인

실행 명령:

- `RUST_LOG=info cargo tauri dev`

관찰 결과:

- 앱이 실제 GUI 프로세스로 실행됐다.
- hidden checker WebView가 `/check-in`을 로드했다.
- 시작 약 2초 안에 `checker.js loaded`, `checker.js ready`, `report: needs_login=false`가 기록됐다.
- report 이후 `data_loaded=true`로 전환됐고 scheduler phase는 `NeedEnd`로 계산됐다.
- 60초 뒤 scheduler tick에서 `trigger_check`가 다시 실행됐고 같은 `needs_login=false` report가 도착했다.
- no-report watchdog recreate/give-up 로그는 발생하지 않았다.
- 로그 검토 시 인증 cookie, WebKit storage, binarycookies 내용은 출력하거나 문서화하지 않았다. API 응답의 내부 식별자는 이 리포트에 기록하지 않았다.

### 남은 리스크

- 이번 수동 검증에서는 watchdog 재생성이 실제로 발동하지 않았다. no-report 판단과 stale watchdog 무시는 단위 테스트로 검증했지만, WebView `destroy()` 후 재생성 통합 경로는 실제 no-report 장애를 강제로 주입해 검증하지 못했다.
- 가장 유력한 원인은 첫 report 전 macOS `ActivationPolicy::Accessory` 전환이 hidden checker 초기화에 영향을 준다는 가설이지만, WebKit 내부 원인은 확정하지 못했다.
- `checker.js ready`가 page-load 세대 증가보다 먼저 도착할 수 있다. 실제 report는 page-load 후 trigger에서도 다시 들어오므로 현재 동작에는 문제가 없지만, ready 세대 로그 해석 시 이 순서를 고려해야 한다.
- 세션 archive와 live WebKit storage는 인증 정보를 포함할 수 있으므로 `/private/tmp`의 재현/검증 디렉터리는 외부 공유 금지다.

### 후속 개선 후보

- no-report 상태를 강제로 만드는 테스트 전용 flag를 추가해 watchdog의 WebView destroy/recreate 통합 경로를 재현한다.
- checker ready/report 이벤트에 page-load generation을 JS에서 직접 전달하도록 보강해 세대 로그를 더 정확하게 만든다.
- watchdog give-up 상태를 실제 장애 주입으로 검증하고, 회색 `상태 확인 불가`가 사용자에게 충분히 명확한지 확인한다.

## 2026-07-08 리뉴얼 후 실제 세션 재현

검증 시각:

- 2026-07-08 10:01-10:03 KST

실행 명령:

- `RUST_LOG=info cargo tauri dev`

재현 root:

- `/private/tmp/jungle-bell-session-repro-20260708-095955`

세션 snapshot 메타데이터:

- archive: `/private/tmp/jungle-bell-session-repro-20260708-095955/session-backups/live-session.tgz`
- size: `9,333,467` bytes
- entries: `954`
- sha256: `954a42d3f37ee7773f5c38af1e525c2b6ed93fb1d7d0f6bf35a1795b638830dd`

세션 archive와 WebKit/HTTPStorages/Caches 파일 내용은 확인하거나 출력하지 않았다.

### 세션 없음 결과

절차:

1. live WebKit/HTTPStorages/Caches 후보 6개를 rollback 위치로 이동했다.
2. 앱을 실행했다.
3. 시작 직후 `/login` 상태에서 checker 보고를 확인했다.

관찰 신호:

- app starting
- web content process terminated
- checker.js loaded
- checker.js ready: generation=0
- report: needs_login=true generation=0
- page loaded: `/login` generation=1
- trigger_check emitted: generation=1
- report: needs_login=true generation=1
- scheduler tick 이후 generation=1 재보고 수신

판정:

- 로그인 없음 상태가 정상적으로 `needs_login=true`로 보고됐다.
- 첫 report 전 stale warning icon으로 굳는 경로는 관찰되지 않았다.
- report가 정상 도착했으므로 no-report watchdog recreate/give-up은 발동하지 않았다.

### 세션 복구 결과

절차:

1. 세션 없음 실행 중 새로 생긴 live session 후보를 별도 rollback 위치로 이동했다.
2. snapshot archive를 live WebKit/HTTPStorages/Caches 위치로 복구했다.
3. 앱을 실행했다.

관찰 신호:

- app starting
- checker.js loaded
- checker.js ready: generation=0
- page loaded: `/check-in` generation=1
- trigger_check emitted: generation=1
- stale generation=0 report ignored
- report: needs_login=false generation=1
- scheduler tick 이후 generation=1 재보고 수신

판정:

- 세션 복구 상태가 정상적으로 `needs_login=false`로 보고됐다.
- generation=0 stale report가 상태에 반영되지 않고 무시됐다.
- report 이후 실제 출석 phase 기반으로 scheduler가 `StartOverdue`를 계산했다.
- report가 정상 도착했으므로 no-report watchdog recreate/give-up은 발동하지 않았다.

### 추가 관찰

- `commands::report_attendance_status`가 stale report를 무시하기 전에 info report 로그를 먼저 찍는 문제가 있었다.
- 수정 후 재실행에서 유효 generation report만 `report:` 로그로 남고, stale report는 `stale report ignored`로만 남는 것을 확인했다.
- attendance window open/close 이후 checker WebView reload가 발생했고 generation=2 report가 정상 수신됐다.

### 남은 리스크

- 실제 no-report 장애 주입은 수행하지 않았다. watchdog recreate/give-up은 단위 테스트로만 검증됐다.
- `/private/tmp`의 snapshot과 rollback 디렉터리는 인증 세션을 포함할 수 있으므로 외부 공유 금지다.

## 2026-08-19 v0.5.0-beta.1 필수 인증 게이트 검증

검증 환경:

- 앱: Jungle Bell `v0.5.0-beta.1` 개발 빌드
- 기준 커밋: `1f909ba` 위 인증 게이트 미커밋 변경
- 실제 창 크기: `1180 × 780` logical pixel
- 재현 root: `/private/tmp/jungle-bell-session-repro-20260819-172307`
- 시각 QA: `/tmp/jungle-bell/20260819-172307-1f909ba`

세션 snapshot 메타데이터:

| 대상 | 크기 | 항목 수 | SHA-256 |
| --- | ---: | ---: | --- |
| 설치 앱 v2 세션 | 1,997,616 bytes | 105 | `1e66da59bbbc17e60aa1de2af63469af5a0a423626c87bd938f893be4d7e6a5b` |
| Tauri dev 세션 | 72,577,159 bytes | 5,080 | `8c96a4af127f345bd96307a8479d5cd94ec93e0a6731ea4f1b31220771ad887d` |

두 archive 모두 mode `600`으로 저장했다. 세션·쿠키·WebKit storage 내용은 열람하거나 출력하지 않았다.

### 인증된 PC 실행

관찰 신호:

- app starting `v0.5.0-beta.1`
- checker.js ready: generation=1
- report: `needs_login=false`
- 대시보드 셸과 현재 홈 콘텐츠 표시
- 기존 셸 내부 LMS 로그인 경고 미표시

판정:

- 명시적 LMS 인증 상태가 `Authenticated`로 전환된 뒤 전역 게이트가 해제됐다.
- `desktop-authenticated.png`에서 실제 창의 오른쪽·아래쪽 클리핑이 없음을 확인했다.

### 세션 없음 PC 실행

절차:

1. 설치 앱 v2 세션과 Tauri dev 세션을 각각 별도 rollback 위치로 이동했다.
2. 개발 앱을 재실행했다.
3. 로그인 필요 report와 전역 게이트를 확인했다.
4. 생성된 미로그인 세션을 분리하고 두 기존 세션을 원래 위치로 복구했다.

관찰 신호:

- app starting `v0.5.0-beta.1`
- checker.js ready: generation=1
- login required: `/login`
- report: `needs_login=true`
- `Jungle Bell 인증` 전체 화면과 `LMS 로그인 창 열기` 버튼 표시
- DashboardShell·라우트 콘텐츠 미표시

판정:

- `Required` 전이 직후 모든 라우트가 차단됐다.
- `desktop-login-required.png`에서 실제 창 크기의 안내·버튼·여백과 클리핑을 확인했다.
- 세션 복구 후 재실행에서 다시 `needs_login=false` report와 대시보드 복귀를 확인했다.

### standalone PWA 및 일반 웹

독립 Chrome 임시 프로필로 `/attendance`를 열어 확인했다.

- Chrome 앱 모드: `display-mode: standalone=true`
- URL: `/attendance` 유지
- 미연결 세션: 전역 게이트 있음, DashboardShell 없음, pairing 입력 화면만 표시
- 모바일 `390 × 844`: `scrollWidth=390`, `scrollHeight=844`, 가로·세로 클리핑 없음
- 일반 브라우저: `standalone=false`, 전역 게이트 없음, DashboardShell 있음, 공개 출석 안내 표시

시각 자료:

- `pwa-unconnected-attendance.png`
- `pwa-unconnected-mobile.png`

### 자동 검증

- `npm run verify`: 통과
  - Vitest 417개 통과
  - Rust unit 193개 및 integration 2개 통과
  - TypeScript·웹/데스크톱 빌드·Rustfmt·Clippy 통과
- React Doctor: 95/100, 신규 진단 없음

### 남은 실제 기기 검증

- 실물 휴대폰에서 pairing 승인 완료와 푸시 권한을 확인해야 한다.
- 연결된 PWA의 background refetch 실패는 상태 단위 테스트로 검증했으며, 실제 네트워크 단절은 릴리즈 설치 후 확인한다.
- 개발 바이너리는 `.app` bundle이 아니므로 macOS 알림 권한 백엔드는 초기화되지 않았다. 알림은 서명된 릴리즈 앱에서 별도로 확인한다.
