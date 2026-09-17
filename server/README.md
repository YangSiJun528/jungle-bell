# Jungle Bell Server

Jungle Bell 서버는 Kotlin Spring Boot 기반의 세 Gradle 모듈로 구성됩니다. HTTP와
백그라운드 호출부는 독립 프로세스로 실행하고, PostgreSQL 접근과 도메인 로직은
`core`에서 공유합니다.

## 모듈

| 모듈 | 역할 | 실행 형태 |
| --- | --- | --- |
| `core` | 도메인 모델, use case, 저장소 port, JDBC adapter, PostgreSQL schema | 라이브러리 JAR |
| `api` | Spring MVC controller, Spring Security opaque-token Resource Server, React SPA 정적 자산 | Spring Boot JAR |
| `worker` | 수집 scheduler, 알림 자동화 호출, Web Push adapter | Spring Boot JAR |

의존 방향은 `api -> core <- worker`뿐입니다. `api`와 `worker`는 서로 참조하지
않습니다. API 프로세스가 schema와 HTTP를 소유하고 Worker 프로세스는 schema를
변경하지 않은 채 같은 PostgreSQL을 사용합니다.

Cloudflare Worker, D1, R2와 별도 TypeScript Jobs 런타임은 사용하지 않습니다. named
Cloudflare Tunnel은 `https://jungle-bell.sijun-yang.com`을 API에 연결하는 정식
ingress입니다.

## 디렉터리

```text
server/
├── core/
│   └── src/main/
│       ├── kotlin/app/junglebell/server/
│       │   ├── domain/                    기능별 모델·서비스·저장소·JDBC adapter
│       │   └── common/                    공통 설정과 오류 타입
│       └── resources/schema.sql           현재 PostgreSQL schema
├── api/
│   └── src/main/
│       ├── kotlin/app/junglebell/server/api/  MVC·Security 호출부
│       └── resources/application.yml      API 설정과 정적 자산
├── worker/
│   └── src/main/
│       ├── kotlin/app/junglebell/server/worker/  scheduler·외부 수집 adapter
│       └── resources/application.yml      Worker 설정
├── deploy/                                운영 Docker Compose와 환경 예시
├── tools/                                 배포 후 smoke test
└── Dockerfile                             SPA와 두 실행 JAR의 다단계 이미지
```

## 로컬 검증

도구 버전은 루트 `mise.toml`에서 관리합니다. 단위·아키텍처 테스트에는 Java 21,
PostgreSQL 통합 테스트와 서버 실행에는 Docker, 웹 자산 빌드에는 Node.js 24가 필요합니다.

테스트는 소스 디렉터리와 Gradle 작업으로 구분합니다.

| 범위 | 소스 디렉터리 | 명령 | Docker |
| --- | --- | --- | --- |
| 단위·아키텍처 | 각 모듈의 `src/test/kotlin` | `./gradlew test` | 불필요 |
| PostgreSQL 통합 | 각 모듈의 `src/integrationTest/kotlin` | `./gradlew integrationTest` | 필수 |
| 전체 검사 | 위 두 범위 | `./gradlew check` | 필수 |

통합 테스트는 Docker가 없으면 실패합니다. 모듈이나 테스트를 지정하려면
`./gradlew :core:integrationTest --tests '*JdbcStoreIntegrationTest'`처럼 실행합니다.
단위 테스트만 실행하려면 `test`를 선택합니다.
로컬 `pre-push` 훅과 Docker 이미지 빌드의 경량 검증은 `test`만 실행합니다.
CI는 Docker를 제공하는 러너에서 `check`로 단위·통합 테스트를 모두 실행합니다.

```bash
cd server
./gradlew check :api:bootJar :worker:bootJar
```

PostgreSQL과 두 실행 프로세스는 저장소 루트에서 시작합니다.

```bash
cp server/deploy/.env.production.example /tmp/jungle-bell.env
# secret 경로와 수집 URL을 수정하고 PUBLIC_BASE_URL을 로컬 주소로 변경
docker compose \
  --env-file /tmp/jungle-bell.env \
  -f server/deploy/compose.production.yml \
  up --build -d postgres api worker
```

운영 Compose는 API를 `127.0.0.1:8080`, Actuator management를
`127.0.0.1:8081`에 각각 노출합니다. Cloudflare Tunnel은 API의 컨테이너 port
`8080`만 사용하며, Actuator는 Tailscale SSH 후 호스트 loopback에서만 조회합니다.
Worker는 HTTP port를 열지 않습니다. 개발 중 수집을 끄려면
`COLLECTORS_ENABLED=false`를 사용합니다.

저장소 루트의 전체 검증 명령은 다음과 같습니다. Docker 이미지 빌드에서는 단위·아키텍처
테스트와 JAR 빌드를 실행하며, PostgreSQL 통합 테스트는 앞선 `check`에서 실행합니다.

```bash
mise exec -- ./server/gradlew --no-daemon -p server check :api:bootJar :worker:bootJar
docker build --target api-runtime -f server/Dockerfile .
docker build --target worker-runtime -f server/Dockerfile .
```

배포된 인증 경계는 공식 origin에서 확인합니다.

```bash
server/tools/smoke-api.sh https://jungle-bell.sijun-yang.com
```

스크립트가 만든 임시 계정은 인증된 identity 삭제 API로 정리되므로 공식 origin을
로컬에서 검증해도 운영 DB에 테스트 계정을 남기지 않습니다.

## 문서

- 배포와 장애 대응: [OPERATIONS.md](./OPERATIONS.md)
- HTTP endpoint: [docs/api-reference.md](./docs/api-reference.md)
- 환경 변수: [docs/environment-reference.md](./docs/environment-reference.md)
- 로그 형식과 필드: [docs/logging-reference.md](./docs/logging-reference.md)
- 사용량 수집·식별 단위·보존·집계 계약: [docs/usage-metrics-reference.md](./docs/usage-metrics-reference.md)
