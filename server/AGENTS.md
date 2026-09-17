# Server

서버는 `api -> core <- worker` 구조입니다. API와 Worker는 별도 프로세스로 실행하며,
도메인 로직과 PostgreSQL 접근은 Core에서 공유합니다.

- [Core](core/AGENTS.md): 도메인 규칙, 저장소와 schema
- [API](api/AGENTS.md): HTTP·인증 경계와 정적 자산
- [Worker](worker/AGENTS.md): 수집·알림 실행과 외부 서비스 연결

실행 환경과 기존 검증 명령은 [서버 개발 안내](README.md)에 있습니다.
