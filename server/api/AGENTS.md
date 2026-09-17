# API

HTTP 요청·응답, 인증·권한 판정과 React SPA 정적 자산 제공을 담당합니다.
도메인 처리와 영속 상태 변경은 Core의 use case에 위임합니다.
공유 PostgreSQL schema의 시작 시 초기화도 API가 담당합니다.

요청·인증 계약은 [HTTP API 레퍼런스](../docs/api-reference.md),
실제 인증 경계는 [Security 호출부](src/main/kotlin/app/junglebell/server/api/security/)에서 확인할 수 있습니다.

라우트·인증·모듈 경계 검사는 [API 테스트](src/test/kotlin/app/junglebell/server/api/),
PostgreSQL을 사용하는 인증 통합 검사는 [API 통합 테스트](src/integrationTest/kotlin/app/junglebell/server/api/)에 있습니다.
