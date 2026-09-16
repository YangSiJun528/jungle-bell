# Codex 하네스 사용

> 문서 유형: 방법 안내(how-to guide)

이 저장소를 연 Codex 앱에서 평소처럼 작업을 요청합니다. 메인이 필요한 내장 에이전트를
선택하고 같은 담당자와 해결까지 작업을 이어갑니다. 여러 단계의 작업은 `/goal`에
원하는 결과·제약·완료 조건을 적어 시작할 수 있습니다. 별도 설치·동기화 명령은 없습니다.

## 역할 설정

역할 원본은 Git으로 관리하는 아래 공식 TOML 파일입니다. 허용할 **프로젝트 스킬**은
각 파일 상단 주석에, 비허용 스킬은 상대 경로의 `skills.config`에 정의합니다.

| 역할 설정 | 용도 |
| --- | --- |
| [jb_frontend.toml](../.codex/agents/jb_frontend.toml) | React·Web·PWA |
| [jb_desktop.toml](../.codex/agents/jb_desktop.toml) | Rust·Tauri·checker |
| [jb_server.toml](../.codex/agents/jb_server.toml) | Spring·DB·API·Worker |
| [jb_reviewer.toml](../.codex/agents/jb_reviewer.toml) | 요청된 코드 리뷰 |
| [jb_visual_qa.toml](../.codex/agents/jb_visual_qa.toml) | 큰 기능·최종 릴리스의 전체 UI 확인 |

역할을 수정하거나 프로젝트 스킬을 추가하면 각 역할의 비활성 목록도 검토합니다.
새 역할 설정은 이를 인식하는 새 앱 대화에서 사용합니다. 전역·시스템·플러그인 스킬과
메인의 목록은 부모 설정 그대로 유지하며, 스킬 본문과 사용자 전역 설정은 수정하지 않습니다.

## 협업과 후속 작업

메인은 `spawn_agent`의 `agent_type`으로 역할을 선택하고 `fork_turns="none"`으로
목표·담당 범위·필요한 맥락만 전달합니다. 공동 목표가 끝날 때까지 같은 담당자를 재사용합니다.
정보 전달은 `send_message`, 쉬고 있는 담당자에게 작업을 이어 맡길 때는 `followup_task`를
사용합니다. 실패·막힘은 메인에 알리고, 메인이 결과 통합과 Goal 진행을 관리합니다.
작업이 없을 때 반복 실행하거나 무한 대기할 필요는 없습니다.

기존 [개발 안내](../CONTRIBUTING.md)의 검사로 변경을 확인하며 별도 모델 QA 승인은
추가하지 않습니다. 스킬 필터는 파일 접근을 차단하는 보안 경계가 아닙니다.
설계 이유와 참고 자료는 [하네스 설계](explanation-codex-harness-plan.md)에 있습니다.
