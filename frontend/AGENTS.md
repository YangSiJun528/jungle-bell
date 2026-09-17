# Frontend

Web·설치 PWA·Tauri PC는 같은 React 화면을 사용하고 실행 환경별 기능을 어댑터로 주입합니다.

- `src/app/`: 진입점과 화면·provider를 조립하고 실행 흐름을 연결합니다.
- `src/navigation/`: 공통 경로를 정의합니다.
- `src/state/`: 계정·대시보드 상태와 query를 관리합니다.
- `src/features/`, `src/components/`: 기능 화면과 공통 UI를 구성합니다.
- `src/domain/`: 화면과 실행 환경에 독립적인 계산·판정 규칙을 둡니다.
- `src/api/`: HTTP 요청과 응답 계약을 다룹니다.
- `src/platform/`: 브라우저·네이티브 기능의 경계입니다. [계층 안내](src/platform/AGENTS.md)를 참고합니다.

공통 화면은 플랫폼 계약을 통해 환경별 기능을 사용합니다. 서버 데이터의 query 상태와
화면 전용 상태, Rust 소유 상태의 구분은 [상태 관리](../docs/state-management-reference.md)를 기준으로 합니다.
HTTP 변경은 [서버 API](../server/docs/api-reference.md), 화면 구성은
[UI 레퍼런스](../docs/ui-layout-reference.md)를 참고합니다.
브라우저·모바일에서 직접 확인할 때는 [환경별 Visual QA](../docs/guide-visual-qa.md)를 사용합니다.
