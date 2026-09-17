# Worker

수집 scheduler, 알림 자동화 호출과 Web Push adapter를 담당합니다.
스케줄링과 외부 I/O는 Worker에서 실행하고, 도메인 규칙과 영속 상태는 Core를 사용합니다.
API와 독립된 프로세스에서 같은 PostgreSQL의 업무 상태를 사용합니다.

실행 흐름은 [수집 호출부](src/main/kotlin/app/junglebell/server/worker/collector/)와
[알림 호출부](src/main/kotlin/app/junglebell/server/worker/automation/)에서 확인할 수 있습니다.

스케줄링·외부 adapter·모듈 경계 검사는 [Worker 테스트](src/test/kotlin/app/junglebell/server/worker/)에 있습니다.
