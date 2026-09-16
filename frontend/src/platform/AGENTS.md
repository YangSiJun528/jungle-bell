# Platform

공통 UI가 사용하는 계약과 실행 환경별 구현을 연결하는 계층입니다.

- `contracts.ts`: 현재 `PlatformAdapter`, capability와 native·PWA 인터페이스입니다.
- `web/`: 일반 웹과 설치 PWA에 맞는 어댑터·HTTP 인증 방식을 구성합니다.
- `pwa/`: 설치, Service Worker, Push와 업데이트 수명주기를 구현합니다.
- `tauri/`: Rust IPC·이벤트를 공통 계약에 연결합니다. [Tauri 계층 안내](tauri/AGENTS.md)를 참고합니다.

계약 변경은 실제 어댑터와 소비 코드를 함께 확인합니다. 연결 예시는
[어댑터 테스트](platform-adapter.test.ts), 기능 경계는 [플랫폼 계약](../../../docs/reference-platform-contract.md)에 있습니다.
`status-model.ts`의 상태 어휘와 어댑터 연결 범위는 [상태 모델](../../../docs/reference-platform-status-model.md)을 참고합니다.
