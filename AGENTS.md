# Jungle Bell

`frontend/`는 공통 React UI와 플랫폼 어댑터, `desktop/`은 Tauri Rust 런타임,
`server/`는 Spring Core·API·Worker를 담습니다.

## 작업 영역

작업 영역에 들어갈 때 루트부터 대상 파일까지 경로상의 `AGENTS.md`를 읽습니다.
폴더 지침은 역할과 관계없이 적용하며, 다른 영역의 지침과 상세 문서는 필요할 때 참조합니다.

- [Frontend](frontend/AGENTS.md): 공통 UI·HTTP와 플랫폼 어댑터
- [Desktop](desktop/AGENTS.md): Rust 런타임과 로컬 상태
- [Server](server/AGENTS.md): Core·API·Worker 모듈

개발·검증은 [개발 안내](CONTRIBUTING.md), 전체 구조는
[플랫폼 아키텍처](docs/explanation-platform-architecture.md), 에이전트 운영은
[하네스 사용 안내](docs/guide-codex-harness.md)를 참고합니다.

## 협업

메인은 독립적인 전문 작업이 있으면 [.codex/agents](.codex/agents/)에서 필요한 역할을 골라
내장 `spawn_agent`의 `agent_type`으로 위임합니다. 새 역할은 `fork_turns="none"`으로
목표·수정 범위·완료 조건·협업 상대와 해당 폴더 지침 위치를 받습니다. 작은 작업은 직접 처리합니다.
Frontend·Desktop·Server는 구현과 해당 변경의 검증을 맡습니다. Reviewer는 요청된 검토,
Visual QA는 요청된 화면·동작 검증이나 큰 기능 완료·최종 릴리스의 전체 화면 확인에 선택적으로 사용합니다.

공유 계약 파일은 작업마다 한 명의 편집 담당자를 정하고, 생산자·소비자 담당자는
변경 내용을 직접 공유합니다. 공동 목표가 끝날 때까지 같은 담당자를 재사용하며,
후속 작업은 `followup_task`, 정보 전달은 `send_message`로 처리합니다.
담당자는 변경 내용·수행한 검사·남은 문제를 간결히 반환합니다. 실패·막힘은 메인에
알리고, 메인은 결과 통합과 Goal 진행을 관리합니다. 작업이 없을 때 반복 실행하거나
미해결 상태로 무한 대기하지 않습니다.

## QA

일반 작업은 최소 스모크와 변경 범위만 확인합니다. 릴리스 전에는
[전체 기능 QA 템플릿](docs/template-release-qa.md)을 저장소 밖에 복사해 수행합니다.
계정 사용·로그인·인증·초기화가 필요하면 담당자는 메인에 알리고, 메인이 사용자에게
필요한 준비와 허용 범위를 요청합니다. 실행 방법과 결과 기록은
[Visual QA 안내](docs/guide-visual-qa.md)를 따릅니다.

## 금지 사항

- 여러 에이전트가 같은 파일을 동시에 수정하지 않습니다.
- 사용자의 기존 변경을 되돌리지 않습니다.
- 인증 정보와 세션 원문을 출력하거나 커밋하지 않습니다.
- 실행하지 않았거나 생략된 검증을 통과로 표시하지 않습니다.
