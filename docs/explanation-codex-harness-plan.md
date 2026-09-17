# Jungle Bell Codex 하네스 설계

> 설명 문서 · 기준: 2026-09-17

**프로젝트 스킬을 역할별로 제한하고, 같은 담당자와 공동 목표를 끝까지 진행한다.**
명세는 짧게, 검증은 재현 가능한 코드로, 프로젝트 지식은 사람과 AI의 공용 문서로 관리한다.

## 채택한 원칙

| 참고 자료 | 이 프로젝트에 적용한 원칙 |
| --- | --- |
| [revfactory/harness](https://github.com/revfactory/harness/blob/main/skills/harness/references/agent-design-patterns.md) | 메인이 필요한 전문가를 선택하고 결과를 통합한다. |
| [OpenAI Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 공식 역할 파일과 내장 위임·후속 작업으로 협업한다. |
| [OpenAI Harness engineering](https://openai.com/index/harness-engineering/) | 짧은 문서 지도로 지식을 연결하고, 판정 가능한 제약은 코드로 확인한다. |
| [OpenAI Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) | 합리적인 가정으로 진행하되, 진전 없는 반복은 중단하고 필요한 질문을 한다. |
| [Superpowers systematic-debugging](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md) | 원인 가설을 최소 실험으로 확인하고, 반복 실패 시 접근을 재검토한다. |
| [Anthropic 지침 작성 가이드](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md) | 사람이 읽기 쉽게 쓰고 일반 지식 대신 프로젝트 특이 사항을 남긴다. |
| [DeepAgents 스킬 상속](https://docs.langchain.com/oss/python/deepagents/subagents#skills-inheritance) | 전문 역할에 필요한 스킬 문맥만 배정하는 원칙을 참고한다. |

위 자료의 원칙을 선택해 적용하며, 각 제품의 실행 방식이나 검증 절차를 그대로 도입하지 않는다.

## 책임과 문서의 위치

구현 역할은 Frontend·Desktop·Server 세 개이며, Reviewer·Visual QA는 필요할 때만 호출한다.
공유 계약의 편집 담당은 한 명으로 정하고, 소비·생산 담당자가 직접 협의한다.
같은 담당자를 재사용하되 계속 계산하거나 무한 대기하도록 강제하지 않는다.

[공식 역할 TOML](../.codex/agents/)은 담당 범위와 프로젝트 스킬을 정한다.
[루트 AGENTS.md](../AGENTS.md)는 공통 협업과 작업 영역의 시작 위치를 안내하고,
폴더별 `AGENTS.md`는 해당 계층의 책임·의존 방향과 하위 지침을 짧게 설명한다.
세부 계약은 기존 플랫폼·상태·API 문서를 연결해 사람과 에이전트가 함께 사용한다.

폴더별 지침은 역할이 아니라 코드 위치에 귀속된다. 작업 경로의 문맥만 단계적으로 읽으므로
서버 담당자가 모든 모듈의 세부 규칙을 처음부터 받을 필요가 없고, 같은 코드를 검토하는
다른 역할도 같은 기준을 찾을 수 있다. 세부 구현 순서는 담당자가 정한다.

역할 설정과 공통 협업 절차는 [하네스 사용 안내](guide-codex-harness.md)에 둔다.
요구사항 확인과 반복 실패 대응의 상세 절차는 [메인 작업 안내](guide-codex-main.md)에 분리한다.
루트에는 메인이 구현·수정 작업을 시작할 때 읽도록 하는 안내만 남겨, 모든 역할이 상세 절차를
문맥에 넣지 않게 한다. 하위 담당자는 모호함·실패·막힘을 메인에 보고하고, 메인이 필요한 진단이나
다음 접근을 전달한다. 이는 진전 없는 반복을 줄이는 행동 지침이며 실행을 강제 종료하는 장치는 아니다.

상대 경로로 저장소 스킬만 역할별로 제한한다. **메인과 전역·시스템·플러그인 스킬은
부모 설정을 그대로 따른다.** 부모가 끈 스킬을 자식이 다시 켤 수 없으며, 이 필터가
파일 접근 권한을 차단하지도 않는다. 스킬 본문은 기존 내용을 유지한다.

## 검증 범위

기존 타입 검사·린트·테스트를 재사용하고, 실제 입력·출력·상태 전이의 회귀를 재현할 때
필요한 테스트를 추가한다. 소스 문자열이나 설정 구조 검사는 동작 검증과 구분한다.
서버 경량 검증은 단위·아키텍처 테스트만 실행하고, CI는 Docker가 필수인 통합 테스트까지 실행한다.
통합 테스트는 Docker가 없으면 실패하며, 단위 테스트만 실행한 결과를 전체 검사 성공으로 보고하지 않는다.
별도 에이전트 실행기·모델 QA 승인·강제 재리뷰 루프는 추가하지 않는다.

역할별 범위와 협업 방법은 [하네스 사용 안내](guide-codex-harness.md)에 있다.
