# 백그라운드 주기 실행 리뉴얼 설계 노트

문서 유형: explanation.

## 반영 원칙

- `page loaded`는 약한 신호다. 상태 확정은 현재 WebView generation의 `checker.js ready`와 `attendance report`를 기준으로 한다.
- 첫 report 전에는 로그인 필요나 출석 경고를 확정 표시하지 않는다. tray는 loading/recovering/offline을 별도 상태로 표시한다.
- WebView recreate 이후 늦게 도착한 이전 generation report는 무시한다.
- timeout/retry/backoff/give-up은 정상 제어 흐름으로 다룬다.
- scheduler는 "언제 어떤 job을 실행할지"만 결정하고, 출석/체커/트레이 정책은 각 모듈의 순수 함수가 판단한다.

## 현재 결합 지점

| 위치 | 현재 책임 | 문제 | 변경 방향 |
| --- | --- | --- | --- |
| `scheduler.rs` | tick 간격, 일일 phase, 알림, tray snapshot, checker refresh, trigger-check | 출석 정책과 checker side effect를 동시에 안다 | `JobAction` 산출과 runtime adapter 호출로 축소 |
| `checker.rs` | AttendanceReport 파싱 타입, report 적용, checker generation, WebView refresh/trigger | 출석 도메인과 checker supervisor가 섞임 | report 적용은 `attendance`, generation/watchdog은 `checker`로 분리 |
| `lib.rs` | hidden checker WebView 생성, page-load 처리, watchdog spawn, recreate | 앱 bootstrap과 checker adapter가 섞임 | checker WebView adapter 함수로 이동 |
| `state.rs` | 전역 상태, DailyPhase, Dday, checker runtime, tray snapshot | 모든 모듈이 상태 필드에 직접 접근 | 외부 입력은 snapshot/update 함수로 제한 |
| `tray.rs` | tray view-model, 창 생성, 로그인 재시도, checker reload | presentation과 window command adapter가 섞임 | tray 표시는 `TraySnapshot -> TrayViewModel`만 보게 유지 |
| `commands.rs` | Tauri IPC, checker report 처리, tray/event/analytics side effect | IPC handler가 도메인 전이를 직접 조합 | 도메인 결과를 받아 adapter side effect만 수행 |

## 새 데이터 흐름

```text
tokio scheduler tick
  -> interval_tasks::JobStore::collect_due_actions()
  -> scheduler::compute_tick()
  -> runtime adapter executes JobAction
      - AttendanceStatusCheck -> checker trigger-check event
      - CheckerSessionRefresh -> checker WebView refresh
      - future MealMenuRefresh/LaundryTimeRefresh -> dedicated adapters

checker WebView adapter
  -> PageLoaded
  -> checker supervisor records generation
  -> emit trigger-check { generation }
  -> start report watchdog { generation }

checker.js
  -> report_checker_ready { generation }
  -> report_attendance_status { status: { generation, ... } }

commands
  -> checker supervisor accepts/ignores generation
  -> attendance domain applies report and computes phase
  -> tray snapshot/view-model update
  -> notification/analytics/event adapters
```

## Extension Point

새 주기 작업은 다음만 추가한다.

1. `JobKind` variant.
2. `JobSpec` registration.
3. runtime adapter의 `JobKind -> side effect` handler.
4. 필요하면 해당 도메인의 순수 상태 전이 테스트.

급식 메뉴 조회나 빨래 시간 확인은 scheduler에 조건문을 추가하지 않고 위 경로로 붙인다.

## 검증 기록

- `cargo fmt --check`: 통과.
- `cargo clippy --locked -- -D warnings`: 통과.
- `cargo test --locked`: 통과, 116 tests.
- 수동 실행: `RUST_LOG=info cargo tauri dev`, 2026-07-08 03:52 KST.
  - 앱 시작, hidden checker WebView page loaded, `checker.js ready`, attendance report 수신을 확인했다.
  - page-load generation 1 기준 report가 수신됐고, 이후 scheduler tick의 `AttendanceStatusCheck`도 같은 generation으로 report를 받았다.
  - 정상 세션 실행에서는 no-report watchdog recreate/give-up이 발생하지 않았다.
  - scheduler가 state lock을 잡은 상태에서 trigger를 실행하던 문제를 수정했고, 재실행에서 `state locked` trigger skip이 사라진 것을 확인했다.
  - checker JS debug 로그는 API raw body와 내부 ID를 출력하지 않도록 메타데이터 로그로 축소했다.
