# Jungle Bell Server 운영 절차

이 문서는 OCI의 v2-test Spring 서버를 배포하고 확인하는 절차입니다. 서버는
PostgreSQL, Spring Boot 애플리케이션, 선택적인 Cloudflare Tunnel로 구성됩니다.

## 운영 원칙

- 애플리케이션과 PostgreSQL은 OCI에서만 실행합니다.
- 데이터베이스 스키마 기준은 `src/main/resources/schema.sql` 하나입니다.
- 정식 사용자가 없는 현재 단계에서는 migration 파일을 만들지 않습니다. 호환되지
  않는 스키마 변경은 test 데이터베이스를 삭제하고 다시 생성합니다.
- 재생성 전에 보존할 데이터는 세탁 기록과 급식 기록뿐입니다.
- secret 값, 데이터베이스 dump, VAPID private key는 저장소에 넣지 않습니다.
- 같은 OCI 호스트의 다른 Compose 프로젝트와 컨테이너는 건드리지 않습니다.

## 최초 준비

OCI 호스트에 다음 디렉터리를 만듭니다.

```bash
install -d -m 0700 ~/.config/jungle-bell-spring-v2-test
```

다음 파일을 생성합니다. 파일 경로는 `deploy/.env.v2-test`에서 절대 경로로
참조합니다.

- `database-password`
- `pairing-secret` — 32자 이상
- `vapid-public-key`
- `vapid-private-key`

secret 디렉터리는 반드시 `0700`이어야 합니다. 컨테이너의 non-root JVM이 Docker
secret을 읽을 수 있도록 파일은 `0644`로 둘 수 있지만, 상위 디렉터리에서 다른
사용자의 접근을 차단해야 합니다.

```bash
cp deploy/.env.v2-test.example deploy/.env.v2-test
chmod 600 deploy/.env.v2-test
```

`.env.v2-test`에서 최소한 다음 값을 설정합니다.

- `PUBLIC_BASE_URL`
- 네 개 secret 파일의 절대 경로
- `LAUNDRY_SOURCE_URL`
- `VAPID_SUBJECT`

## 일반 배포

저장소 내용을 OCI의 전용 디렉터리에 동기화한 뒤 Compose를 검증합니다.

```bash
cd ~/jungle-bell-spring-v2-test
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  --profile quick-tunnel config --quiet
```

애플리케이션 이미지를 빌드하고 PostgreSQL과 서버를 갱신합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  build app
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d postgres app
```

고정 Tunnel token이 있으면 `--profile tunnel`을, 임시 검증 URL이면
`--profile quick-tunnel`을 사용합니다. Quick Tunnel URL은 cloudflared 프로세스가
재생성되면 바뀌므로 정식 배포 주소로 사용하지 않습니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  --profile quick-tunnel up -d quick-tunnel
```

## 이전 기록 확인

2026년 8월 13일 cutover에서 이전 서버의 급식·세탁 기록만 PostgreSQL로 옮겼습니다.
일회성 importer는 배포 코드에서 제거했습니다. 사용자, session, 설정과 알림은
이전하지 않았습니다.

```bash
docker exec jungle-bell-postgres-v2-test psql -U jungle_bell -d jungle_bell -c '
SELECT
  (SELECT count(*) FROM meal_post) AS meal_posts,
  (SELECT count(*) FROM meal_image) AS meal_images,
  (SELECT count(*) FROM minute_observation) AS minute_observations;'
```

## 스키마 초기화

정식 사용자가 없는 동안 호환되지 않는 변경은 volume을 새로 만듭니다. 이 작업은
모든 계정·설정·알림과 기록을 삭제합니다. 기록 보존이 필요하면 먼저 `pg_dump`로
급식·세탁 테이블을 저장하고 새 스키마에 맞게 검증한 restore 계획을 준비합니다.

정확한 Compose 프로젝트와 volume 이름을 확인한 뒤에만 실행합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  down
docker volume rm jungle-bell-v2-test_jungle-bell-postgres-v2-test
```

운영 사용자가 생긴 뒤에는 이 절차를 사용하지 말고 정식 migration 체계를 도입해야
합니다.

## 배포 확인

```bash
curl --fail --silent https://example.test/actuator/health/readiness
curl --fail --silent https://example.test/api/health
curl --fail --silent https://example.test/api/public/status
curl --fail --silent https://example.test/api/public/laundry
curl --fail --silent https://example.test/api/public/meals
curl --fail --silent https://example.test/dashboard.html >/dev/null
server/tools/smoke-api.sh https://example.test
```

상태 응답에서 세 source의 `consecutiveFailures`가 0인지, `lastSuccessAt`이 현재 시각에
맞게 갱신되는지 확인합니다. 1분 이상 기다린 뒤 세탁 observation 수가 증가하는지도
확인합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  logs --since 10m app postgres
```

## 롤백

코드 문제이면 직전 이미지 tag를 `APP_IMAGE`에 지정하고 app만 다시 생성합니다.
스키마를 바꿨다면 이전 이미지와 현재 스키마의 호환성을 추측하지 말고, 검증된
PostgreSQL backup을 기준으로 새 volume을 준비합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d --no-deps --force-recreate app
```
