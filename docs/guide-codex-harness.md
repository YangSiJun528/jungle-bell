# Codex 하네스 사용

> 문서 유형: 방법 안내(how-to guide)

이 저장소를 연 Codex 앱에서 평소처럼 작업을 요청합니다. 메인이 필요한 내장 에이전트를
선택하고 같은 담당자와 해결까지 작업을 이어갑니다. 여러 단계의 작업은 `/goal`에
원하는 결과·제약·완료 조건을 적어 시작할 수 있습니다. 별도 설치·동기화 명령은 없습니다.

## 역할 설정

역할 원본은 Git으로 관리하는 아래 공식 TOML 파일입니다. 허용할 **프로젝트 스킬**은
각 파일 상단 주석에, 비허용 스킬은 상대 경로의 `skills.config`에 정의합니다.

| 역할 설정 | 담당 범위 |
| --- | --- |
| [jb_frontend.toml](../.codex/agents/jb_frontend.toml) | 공통 React·HTTP·Web·PWA |
| [jb_desktop.toml](../.codex/agents/jb_desktop.toml) | `desktop/**`, `frontend/src/platform/tauri/**`와 checker TypeScript |
| [jb_server.toml](../.codex/agents/jb_server.toml) | Core·JDBC·API·Worker |
| [jb_reviewer.toml](../.codex/agents/jb_reviewer.toml) | 선택 호출: 요청된 결함 근거·회귀 분석 |
| [jb_visual_qa.toml](../.codex/agents/jb_visual_qa.toml) | 선택 호출: 요청된 화면·동작, 큰 기능 완료·최종 릴리스의 전체 UI 확인 |

역할을 수정하거나 프로젝트 스킬을 추가하면 각 역할의 비활성 목록도 검토합니다.
새 역할 설정은 이를 인식하는 새 앱 대화에서 사용합니다. 전역·시스템·플러그인 스킬과
메인의 목록은 부모 설정 그대로 유지하며, 스킬 본문과 사용자 전역 설정은 수정하지 않습니다.

## 작업 영역의 문맥

역할 파일은 담당 범위와 지침의 시작 위치를 지정합니다. 계층별 설명은 작업 경로의
`AGENTS.md`를 따라 읽습니다. 예를 들어 Worker 작업은 루트 → `server/AGENTS.md` →
`server/worker/AGENTS.md` 순서이며, 상세 API·상태 문서는 해당 변경에 필요할 때 참조합니다.
같은 폴더의 지침을 구현·리뷰 담당자가 함께 사용합니다.

[Codex의 자동 발견](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance)은
시작 작업 디렉터리까지의 경로를 기준으로 합니다. 루트에서 시작한 작업도 하위 지침을
찾아 읽도록 [루트 지침](../AGENTS.md)에 명시했습니다.

## 협업과 후속 작업

메인은 `spawn_agent`의 `agent_type`으로 역할을 선택하고 `fork_turns="none"`으로
목표·완료 조건·수정 범위·협업 상대와 해당 폴더 지침 위치를 전달합니다. 모든 역할을 실행할 필요는 없습니다.
공유 계약은 한 명이 편집하고, 소비·생산 담당자가 직접 소통합니다. 같은 담당자를 목표 완료까지 재사용합니다.
정보 전달은 `send_message`, 쉬고 있는 담당자에게 작업을 이어 맡길 때는 `followup_task`를
사용합니다. 실패·막힘은 메인에 알리고, 메인이 결과 통합과 Goal 진행을 관리합니다.
결과는 변경·실행한 검사·남은 문제로 짧게 전달합니다. 공통 협업 규칙은 [AGENTS.md](../AGENTS.md)에 있습니다.

검증은 기존 [개발 안내](../CONTRIBUTING.md)를 따릅니다. 직접 UI를 확인할 때의 브라우저·모바일·PC 환경 선택은
[환경별 Visual QA](guide-visual-qa.md)를 참고합니다. Docker가 없으면 일부 DB 통합
테스트가 생략될 수 있으므로 성공과 구분해 보고합니다. 스킬 필터는 파일 접근을 차단하는 보안 경계가 아닙니다.
설계 이유와 참고 자료는 [하네스 설계](explanation-codex-harness-plan.md)에 있습니다.
