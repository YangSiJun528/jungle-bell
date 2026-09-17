# Desktop

Tauri Rust 런타임은 LMS 수집과 PC 로컬 상태, 창·트레이·운영체제 기능을 소유합니다.

- `src/lib.rs`: 서비스와 Tauri command·플러그인을 조립합니다.
- `src/state.rs`, `src/attendance.rs`: checker 관측을 런타임 상태와 출석 판정으로 반영합니다.
- `src/commands.rs`: WebView IPC의 진입점이며 처리는 담당 서비스에 위임합니다.
- `src/checker.rs`: LMS WebView와 수집 수명주기를 관리하고 [checker TS](../frontend/src/platform/tauri/checker/checker.ts)와 연결됩니다.
- `src/scheduler.rs`, `src/runtime.rs`: 주기 작업을 결정하고 트레이·checker 등 실행 효과를 적용합니다.
- `src/remote_sync.rs`: 서버 동기화와 알림 전달을 연결합니다. 트레이와 알림함·OS 전달은 각각의 모듈이 맡습니다.

React 쪽 연결은 [Tauri 어댑터 안내](../frontend/src/platform/tauri/AGENTS.md), 서비스별 상태 소유권은
[상태 관리](../docs/state-management-reference.md), HTTP·IPC 상세는 [플랫폼 계약](../docs/reference-platform-contract.md)을 참고합니다.
창·트레이·OS 동작의 직접 확인은 [환경별 Visual QA](../docs/guide-visual-qa.md)를 참고합니다.
