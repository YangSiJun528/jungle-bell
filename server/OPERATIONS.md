# Jungle Bell Server 운영 절차

이 문서는 OCI의 v2-test Spring 서버를 배포하고 확인하는 절차입니다. 런타임은
PostgreSQL, HTTP API, 백그라운드 Worker와 선택적인 Cloudflare Tunnel로 구성됩니다.

## 운영 원칙

- API, Worker와 PostgreSQL은 OCI에서 실행합니다.
- 데이터베이스 스키마 기준은 `core/src/main/resources/schema.sql` 하나입니다.
- API가 시작할 때 schema를 적용하고 Worker는 schema 초기화를 실행하지 않습니다.
- 정식 사용자가 없는 현재 단계에서는 migration 파일을 만들지 않습니다. 호환되지
  않는 스키마 변경은 test 데이터베이스를 삭제하고 다시 생성합니다.
- 재생성 전에 보존할 데이터는 세탁 기록과 급식 기록뿐입니다.
- secret 값, 데이터베이스 dump, VAPID private key는 저장소에 넣지 않습니다.
- 같은 OCI 호스트의 다른 Compose 프로젝트와 컨테이너는 건드리지 않습니다.

## 최초 준비

OCI 호스트에 secret 디렉터리를 만듭니다.

```bash
install -d -m 0700 ~/.config/jungle-bell-spring-v2-test
```

다음 파일을 생성합니다.

- `database-password`
- `pairing-secret` — 32자 이상
- `vapid-public-key`
- `vapid-private-key`

secret 디렉터리는 `0700`이어야 합니다. 컨테이너의 non-root JVM이 Docker secret을
읽을 수 있도록 파일은 `0644`로 둘 수 있지만 상위 디렉터리 접근은 차단합니다.

```bash
cp deploy/.env.v2-test.example deploy/.env.v2-test
chmod 600 deploy/.env.v2-test
```

`.env.v2-test`에서 최소한 다음 값을 설정합니다.

- `PUBLIC_BASE_URL`
- 네 secret 파일의 절대 경로
- `LAUNDRY_SOURCE_URL`
- `VAPID_SUBJECT`

## 일반 배포

저장소 내용을 OCI 전용 디렉터리에 동기화한 뒤 Compose를 검증합니다.

```bash
cd ~/jungle-bell-spring-v2-test
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  --profile quick-tunnel config --quiet
```

API와 Worker 이미지를 빌드하고 순서대로 갱신합니다. API readiness가 통과한 뒤
Worker가 시작되므로 Worker가 초기화 전 schema를 읽지 않습니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  build api worker
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d postgres api worker
```

단일 `app` 서비스에서 처음 전환할 때는 기존 API 컨테이너가 port를 점유하지 않도록
같은 Compose 프로젝트를 한 번 내린 뒤 시작합니다. named PostgreSQL volume은
`down`만으로 삭제되지 않습니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  down
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d postgres api worker
```

고정 Tunnel token이면 `--profile tunnel`, 임시 URL이면 `--profile quick-tunnel`을
사용합니다. Quick Tunnel URL은 cloudflared가 재생성되면 바뀝니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  --profile quick-tunnel up -d quick-tunnel
```

## 이전 기록 확인

2026년 8월 13일 cutover에서는 이전 서버의 급식·세탁 기록만 PostgreSQL로
옮겼습니다. 일회성 importer는 배포 코드에서 제거했습니다.

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
급식·세탁 테이블을 저장하고 검증된 restore 계획을 준비합니다.

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
curl --fail --silent https://example.test/ >/dev/null
server/tools/smoke-api.sh https://example.test
```

상태 응답에서 세 source의 `consecutiveFailures`가 0이고 `lastSuccessAt`이 현재
시각에 맞는지 확인합니다. Worker가 실행 중이며 세탁 observation이 매분 증가하는지도
확인합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  ps api worker postgres
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  logs --since 10m api worker postgres
```

## 롤백

API 문제이면 직전 tag를 `API_IMAGE`, Worker 문제이면 `WORKER_IMAGE`에 지정하고 해당
서비스만 다시 생성합니다. schema가 바뀌었다면 이미지 호환성을 추측하지 말고
검증된 PostgreSQL backup으로 새 volume을 준비합니다.

```bash
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d --no-deps --force-recreate api
docker compose \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  up -d --no-deps --force-recreate worker
```
