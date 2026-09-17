# Core

기능별 도메인 모델, use case, 저장소 port와 JDBC adapter를 함께 관리합니다.
API·Worker가 공유하는 비즈니스 규칙과 영속 상태의 기준입니다.

영속 상태는 [schema.sql](src/main/resources/schema.sql)과
기능별 [도메인·저장소 코드](src/main/kotlin/app/junglebell/server/domain/)에 정의됩니다.
Schema를 실제 적용하는 프로세스는 API입니다.

단위·아키텍처 테스트는 [Core 테스트](src/test/kotlin/app/junglebell/server/),
PostgreSQL 통합 테스트는 [Core 통합 테스트](src/integrationTest/kotlin/app/junglebell/server/)에 있습니다.
