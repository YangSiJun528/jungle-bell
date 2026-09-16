# Jungle Bell Codex 하네스 설계

> 설명 문서 · 기준: 2026-09-17

**프로젝트 스킬을 역할별로 제한하고, 같은 담당자와 공동 목표를 끝까지 진행한다.**
명세는 짧게, 검증은 재현 가능한 코드로, 프로젝트 지식은 사람과 AI의 공용 문서로 관리한다.

## 역할과 실행 경계

[Harness의 Expert Pool·Supervisor 방식](https://github.com/revfactory/harness/blob/main/skills/harness/references/agent-design-patterns.md)을
[OpenAI 내장 Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)에 적용한다.
메인이 필요한 전문 역할을 선택하고 통합하며, 담당자는 직접 소통과 후속 작업을 이어간다.
[Long-running work](https://learn.chatgpt.com/docs/long-running-work)의 결과·제약·완료 조건을
Goal로 삼는다. 담당자 유지는 상시 연산이나 무한 대기를 뜻하지 않는다.

[공식 역할 TOML](../.codex/agents/)을 프로젝트에서 직접 관리한다. 상대 경로로 지정한
저장소 스킬만 역할별로 비활성화하며 별도 설정 원본이나 생성기는 두지 않는다.
**메인과 전역·시스템·플러그인 스킬은 부모 설정을 그대로 따른다.** 전체 스킬을 엄격히
격리하는 구성은 아니다. 부모가 이미 끈 스킬을 자식이 다시 켤 수도 없다.
스킬 필터는 컨텍스트 노출 제어이며 파일 접근 권한을 차단하지 않는다.

## 간결한 명세와 공용 지식

[Harness 스킬 작성 가이드](https://github.com/revfactory/harness/blob/main/skills/harness/references/skill-writing-guide.md)와
[OpenAI 스킬·프롬프트 가이드](https://learn.chatgpt.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)를
참고해 목표·관련 위치·완료 조건과 실제 금지 사항만 남긴다. 구현 순서나 판단 방법은
고정하지 않는다. 프로젝트 설명은 [개발 안내](../CONTRIBUTING.md)와 기존 플랫폼·상태·API
문서에 두고, [AGENTS.md](../AGENTS.md)와 역할 파일에서는 필요한 문서를 연결한다.

검증은 기존 타입 검사·린트·테스트를 재사용하고, 새 테스트는 실제 입력·출력·상태 전이의
회귀를 재현할 때 추가한다. 스킬 본문·실행 조건과 Git 훅·CI는 유지하며 모델 QA 승인,
품질 점수, 강제 재리뷰 루프는 추가하지 않는다. 미수행·생략 검증은 성공으로 보고하지 않는다.
설정 파일의 존재만으로 실제 스킬 노출 제한이 검증됐다고 판단하지 않는다.

역할별 파일과 협업 방법은 [하네스 사용 안내](guide-codex-harness.md)에 있다.
