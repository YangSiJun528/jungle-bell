# Jungle Bell

`frontend/`는 공통 React UI와 플랫폼 어댑터, `desktop/`은 Tauri Rust 런타임,
`server/`는 Spring Core·API·Worker를 담습니다.

## 참고 문서

- [개발 안내](CONTRIBUTING.md): 로컬 실행, 기존 검사와 CI
- [플랫폼 계약](docs/reference-platform-contract.md): Web·PWA·PC 기능과 API·IPC 경계
- [상태 관리](docs/state-management-reference.md): 상태 소유권, 저장소와 동기화
- [플랫폼 상태 모델](docs/reference-platform-status-model.md): capability와 상태 어휘
- [서버 API](server/docs/api-reference.md): HTTP 요청·응답과 인증
- [Codex 하네스](docs/guide-codex-harness.md): 내장 에이전트 역할과 프로젝트 설정

메인은 독립적인 전문 작업이 있으면 [.codex/agents](.codex/agents/)에서 필요한 역할을 골라
내장 `spawn_agent`의 `agent_type`으로 위임합니다. 새 역할은 `fork_turns="none"`으로
목표·담당 범위·필요한 맥락만 받습니다. 공동 목표가 끝날 때까지 같은 담당자를 재사용하고,
후속 작업은 `followup_task`, 에이전트 간 정보 전달은 `send_message`로 처리합니다.
실패·막힘은 메인에 알리고, 메인은 결과 통합과 Goal 진행을 관리합니다. 작업이 없을 때
반복 실행하거나 미해결 상태로 무한 대기하지 않습니다. 작은 작업은 직접 처리합니다.

## 금지 사항

- 여러 에이전트가 같은 파일을 동시에 수정하지 않습니다.
- 사용자의 기존 변경을 되돌리지 않습니다.
- 인증 정보와 세션 원문을 출력하거나 커밋하지 않습니다.
- 실행하지 않았거나 생략된 검증을 통과로 표시하지 않습니다.
