# Codex 하네스 사용

> 문서 유형: 방법 안내(how-to guide)

이 저장소를 연 Codex 앱에서 평소처럼 작업을 요청합니다. 메인이 필요한 내장 에이전트를
선택하고 같은 담당자와 해결까지 작업을 이어갑니다. 여러 단계의 작업은 `/goal`에
원하는 결과·제약·완료 조건을 적어 시작할 수 있습니다. 별도 설치·동기화 명령은 없습니다.

메인 전용 판단 절차는 [메인 작업 안내](guide-codex-main.md)에 있습니다.

## 역할 설정

역할 원본은 Git으로 관리하는 아래 공식 TOML 파일입니다. 허용할 **프로젝트 스킬**은
각 파일 상단 주석에, 비허용 스킬은 상대 경로의 `skills.config`에 정의합니다.
다섯 역할의 모델과 추론 수준은 각 파일에서 `gpt-6-astra`와 `medium`으로 고정합니다.

| 역할 설정 | 담당 범위 |
| --- | --- |
| [jb_frontend.toml](../.codex/agents/jb_frontend.toml) | 공통 React·HTTP·Web·PWA |
| [jb_desktop.toml](../.codex/agents/jb_desktop.toml) | `desktop/**`, `frontend/src/platform/tauri/**`와 checker TypeScript |
| [jb_server.toml](../.codex/agents/jb_server.toml) | Core·JDBC·API·Worker |
| [jb_reviewer.toml](../.codex/agents/jb_reviewer.toml) | 동작·계약·상태·실행 설정·검증 규칙 변경의 독립 검토, 요청된 리뷰 |
| [jb_visual_qa.toml](../.codex/agents/jb_visual_qa.toml) | 실제 화면·OS 동작의 완료 조건 확인, 큰 기능 완료·최종 릴리스의 전체 UI 확인 |

역할을 수정하거나 프로젝트 스킬을 추가하면 각 역할의 비활성 목록도 검토합니다.
새 역할 설정은 이를 인식하는 새 앱 대화에서 사용합니다. 전역·시스템·플러그인 스킬과
메인의 목록은 부모 설정 그대로 유지하며, 스킬 본문과 사용자 전역 설정은 수정하지 않습니다.

## 작업명 접두어 훅

[프로젝트 훅 설정](../.codex/hooks.json)은 `spawn_agent` 실행 전에
[접두어 스크립트](../.codex/hooks/prefix-agent-task-name.mjs)를 실행합니다.
관리하는 다섯 역할의 `agent_type`을 작업명 앞에 붙입니다. 예를 들어 `jb_reviewer`의
`review_guidance`는 `jb_reviewer_review_guidance`가 됩니다. 이미 같은 역할명으로 시작하는
작업명은 그대로 두며, 역할 선택·모델·작업 지시 등 나머지 인수는 바꾸지 않습니다.
이 훅은 호출을 차단하지 않으며, 관리 대상이 아닌 역할에는 적용하지 않습니다.

실행 환경의 `PATH`에 Node.js와 Git이 있어야 합니다. 스크립트 경로는 Git 루트에서 구하므로
저장소 하위 폴더에서 시작한 작업에도 적용됩니다.
처음 사용하거나 훅 정의가 바뀌면 앱의 설정 → Hooks 또는 CLI의 `/hooks`에서
이 프로젝트 훅을 검토하고 신뢰해야 합니다.
신뢰 전에는 Codex가 훅을 건너뜁니다. 훅 신뢰는 사용자 환경에 저장하며 저장소에서 대신 설정하지 않습니다.
자세한 동작은 [Codex 훅 문서](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)를 참고합니다.

## 작업 영역의 문맥

역할 파일은 담당 범위와 지침의 시작 위치를 지정합니다. 계층별 설명은 작업 경로의
`AGENTS.md`를 따라 읽습니다. 예를 들어 Worker 작업은 루트 → `server/AGENTS.md` →
`server/worker/AGENTS.md` 순서이며, 상세 API·상태 문서는 해당 변경에 필요할 때 참조합니다.
같은 폴더의 지침을 구현·리뷰 담당자가 함께 사용합니다.

[Codex의 자동 발견](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance)은
시작 작업 디렉터리까지의 경로를 기준으로 합니다. 루트에서 시작한 작업도 하위 지침을
찾아 읽도록 [루트 지침](../AGENTS.md)에 명시했습니다.

## 협업과 후속 작업

메인은 조사·작업 분해·위임·결과 통합·검증 관리를 맡고, 전문 역할의 담당 범위에 속하는 구현·수정은 위임합니다.
이 범위에서 직접 수정은 의미·로직·동작·계약·설정·산출 결과를 바꾸지 않는 문서·주석의 단순 오타·서식에
한정합니다. 변경의 줄 수·파일 수·예상 작업 시간이 작다는 이유로 직접 구현하지 않습니다.
상세 기준은 [수정 담당자 선택](guide-codex-main.md#수정-담당자-선택)을 따릅니다.

메인은 `spawn_agent`의 `agent_type`으로 전문 역할을 선택하고 `fork_turns="none"`으로
목표·완료 조건·수정 범위·협업 상대와 해당 폴더 지침 위치를 전달합니다. 모든 역할을 실행할 필요는 없습니다.
공유 계약은 한 명이 편집하고, 소비·생산 담당자가 직접 소통합니다. 같은 담당자를 목표 완료까지 재사용합니다.
정보 전달은 `send_message`, 쉬고 있는 담당자에게 작업을 이어 맡길 때는 `followup_task`를
사용합니다. 실패·막힘은 메인에 알리고, 메인이 결과 통합과 Goal 진행을 관리합니다.
결과는 변경과 완료 조건별 통과·실패·미검증, 실행·관찰 근거와 남은 문제로 짧게 전달합니다.
공통 협업 규칙은 [AGENTS.md](../AGENTS.md)에 있습니다.

## 검증 결과 전달

모든 작업은 완료 조건을 검사·관찰 결과와 연결합니다. 독립 검토가 필요한 변경은 구현 담당자의
자체 검증 후 Reviewer가 요구사항과 실제 변경·검사 범위를 확인합니다. 독립 검토는 구현 위임을
대신하지 않습니다. 결함이 발견되면 편집 담당자가 수정하고 해당 조건을 재검증합니다.
여러 영역을 연결한 결과는 최종 조합의 계약과 대표 흐름도 확인합니다.

검증자는 결함을 찾지 못한 코드 검토와 실제 실행 결과를 구분하고, 근거가 부족한 조건은
미검증으로 반환합니다. 필수 조건의 실패·미검증이 남으면 완료로 처리하지 않습니다.
범위 선택과 결과 통합 절차는 메인의 [작업별 검증과 완료 판정](guide-codex-main.md#작업별-검증과-완료-판정)에 있습니다.

검증은 기존 [개발 안내](../CONTRIBUTING.md)를 따릅니다. 직접 UI를 확인할 때의 브라우저·모바일·PC 환경 선택은
[환경별 Visual QA](guide-visual-qa.md)를 참고합니다. 서버의 `test`는 단위·아키텍처 테스트,
`integrationTest`는 PostgreSQL 통합 테스트를 실행하고 `check`는 둘 다 실행합니다.
통합 테스트는 Docker가 없으면 실패합니다. `test`만 실행했다면 통합 테스트는 미실행으로 보고합니다.
서버 경량 검증과 로컬 `pre-push`는 `test`만 실행하며, CI는 `check`로 통합 테스트까지 실행합니다.
스킬 필터는 파일 접근을 차단하는 보안 경계가 아닙니다.
설계 이유와 참고 자료는 [하네스 설계](explanation-codex-harness-plan.md)에 있습니다.
