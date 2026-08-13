# Jungle Bell Server

Jungle Bell의 HTTP API, 정적 웹 자산, 공개 데이터 수집, 알림 계획과 Web Push 전송을
하나의 Kotlin Spring Boot 애플리케이션으로 실행합니다. 운영 데이터는 PostgreSQL에
저장하고 서버 전체를 OCI의 Docker Compose로 배포합니다.

## 구성

- Kotlin 2.3, Java 21
- Spring Boot 4.1
- Spring MVC
- Spring Security의 stateless bearer/cookie 인증 필터
- Spring Data JDBC와 PostgreSQL 17
- Spring Scheduler 기반 수집·알림·housekeeping
- Gradle Wrapper
- React/Astro 정적 자산을 포함한 단일 OCI 이미지

Cloudflare Worker, D1, R2, 별도 TypeScript Jobs 런타임은 사용하지 않습니다.
외부 공개 URL이 필요하면 OCI 애플리케이션 앞에 Cloudflare Tunnel을 둘 수 있지만,
Cloudflare는 실행·저장 계층이 아닙니다.

## 디렉터리

```text
server/
├── src/main/kotlin/app/junglebell/server/
│   ├── account/       PC 등록, heartbeat, 출석 snapshot, 모바일 session
│   ├── pairing/       PC-PWA 연결
│   ├── personal/      출석·급식 설정, 세탁 watch
│   ├── notification/  알림 inbox, ack, Push subscription
│   ├── publicapi/     공개 세탁·급식·상태 API와 정적 자산
│   ├── collector/     세탁·급식 수집과 정규화
│   ├── automation/    알림 계획, Web Push, housekeeping
│   └── security/      bearer/cookie 인증과 origin 검증
├── src/main/resources/
│   ├── application.yml
│   └── schema.sql     현재 기준의 단일 PostgreSQL 스키마
├── deploy/            OCI Docker Compose와 환경 예시
├── tools/             배포 후 smoke test
└── Dockerfile         웹과 서버를 함께 빌드하는 다단계 이미지
```

## 로컬 실행

필수 도구는 Java 21, Docker, Node.js 24입니다.

```bash
cd server
./gradlew test
```

PostgreSQL을 포함한 전체 런타임은 저장소 루트에서 실행합니다.

```bash
cp server/deploy/.env.v2-test.example /tmp/jungle-bell.env
# /tmp/jungle-bell.env의 secret 파일 경로와 수집 URL을 수정
docker compose \
  --env-file /tmp/jungle-bell.env \
  -f server/deploy/compose.v2-test.yml \
  up --build -d postgres app
```

애플리케이션은 기본적으로 `127.0.0.1:8080`에만 노출됩니다. 수집기를 실행하지 않는
개발 환경에서는 `COLLECTORS_ENABLED=false`를 사용합니다.

## 검증

```bash
npm run verify:server
docker build -f server/Dockerfile .
```

배포된 환경의 인증 경계까지 확인하려면 OCI 호스트에서 다음을 실행합니다.

```bash
server/tools/smoke-api.sh https://example.test
```

스크립트는 임시 PC 계정을 만든 뒤 출석·설정·세탁 watch·모바일 목록·origin 제한을
검증하고 테스트 계정을 삭제합니다.

## 문서

- 배포와 장애 대응: [OPERATIONS.md](./OPERATIONS.md)
- HTTP endpoint: [docs/api-reference.md](./docs/api-reference.md)
- 환경 변수와 secret: [docs/environment-reference.md](./docs/environment-reference.md)
