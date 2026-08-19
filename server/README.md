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

필수 도구는 Java 21, Docker, Node.js 24입니다.

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

API는 기본적으로 `127.0.0.1:8080`에만 노출됩니다. Worker는 HTTP port를 열지
않습니다. 개발 중 수집을 끄려면 `COLLECTORS_ENABLED=false`를 사용합니다.

저장소 루트의 전체 검증 명령은 다음과 같습니다.

```bash
cd server
./gradlew --no-daemon check :api:bootJar :worker:bootJar
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
