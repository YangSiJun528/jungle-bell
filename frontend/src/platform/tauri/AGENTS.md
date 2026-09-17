# Tauri 프런트엔드 어댑터

이 디렉터리는 공통 React UI와 [Rust 런타임](../../../../desktop/AGENTS.md) 사이를 연결합니다.

- `adapter.ts`: native bridge, 이벤트, 로컬 설정과 단기 HTTP session을 구성합니다.
- `native-bridge.ts`, `event-adapter.ts`: Rust command·이벤트를 프런트엔드 계약으로 옮깁니다.
- `desktop-http-session.ts`: 서버 소유 개인 데이터를 직접 HTTP로 호출할 때 사용할 session을 관리합니다.
- `checker/checker.ts`: 대시보드 코드가 아니라 LMS WebView에 주입되는 수집 코드이며 `desktop/src/checker.rs`와 함께 동작합니다.

IPC·이벤트 변경은 Rust 생산자와 프런트엔드 소비자를 함께 확인합니다. 로컬 관측과 서버 동기화는
서로 다른 상태로 전달하며, 상세 경계는 [플랫폼 계약](../../../../docs/reference-platform-contract.md)을 참고합니다.
