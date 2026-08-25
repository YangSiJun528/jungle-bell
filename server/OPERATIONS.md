# Jungle Bell 서버 운영 절차

이 문서는 Jungle Bell 운영 서버를 배포하고 검증하는 방법을 설명합니다. 런타임은
PostgreSQL, Spring Boot API, 백그라운드 Worker, named Cloudflare Tunnel로 구성됩니다.

OCI 최초 전환과 데이터 이관은
[`deploy/guide_oci_production_deployment.md`](deploy/guide_oci_production_deployment.md)를
따릅니다.

공식 서비스 origin은 다음 하나입니다.

```text
https://jungle-bell.sijun-yang.com
```

## 운영 원칙

- API, Worker, PostgreSQL은 한 Docker Compose 프로젝트로 실행합니다.
- named Cloudflare Tunnel을 정식 ingress로 사용하고 API port는 호스트 loopback에만
  노출합니다.
- React 정적 자산과 REST API는 Spring Boot API가 같은 origin에서 제공합니다.
- `PUBLIC_BASE_URL`은 정적 자산, 공개 API 자산 URL, pairing QR 등 서버가 만드는 외부
  URL의 기준입니다.
- 데이터베이스 스키마 기준은 `core/src/main/resources/schema.sql` 하나입니다.
- API가 시작할 때 schema를 적용하고 Worker는 schema 초기화를 실행하지 않습니다.
- secret, 데이터베이스 dump, VAPID private key는 저장소에 넣지 않습니다.
- 같은 호스트의 다른 Compose 프로젝트와 컨테이너는 건드리지 않습니다.
- 로컬 `server/deploy/.env.production`을 운영 설정의 원본으로 사용합니다. 매 배포마다
  이 파일을 서버로 전송하며, 서버에 남아 있는 이전 환경 파일을 재사용하지 않습니다.

## 버전과 배포 기록

제품, 서버, 프런트엔드, 데스크톱은 하나의 SemVer를 사용합니다. 정식 릴리스는
`MAJOR.MINOR.PATCH`, 시험 릴리스는 `MAJOR.MINOR.PATCH-(alpha|beta|rc).NUMBER` 형식이며
`-SNAPSHOT`은 사용하지 않습니다. 현재 소스 버전은 `0.5.0-beta.0`입니다. 버전을 바꿀
때는 `$bump-version` 스킬로 다음 항목을 함께 갱신합니다.

- `frontend/package.json`과 `frontend/package-lock.json`
- `server/build.gradle.kts`
- `desktop/Cargo.toml`과 `desktop/Cargo.lock`
- `desktop/tauri.conf.json`

다음 계약 테스트가 통과해야 배포할 수 있습니다.

```bash
npm --prefix frontend test -- src/tests/contracts/release-channel.test.ts
```

버전 문자열만으로 배포물을 식별하지 않습니다. 배포마다 다음 필드를 같은 기록에
남깁니다.

```text
version=<SemVer>
gitSha=<40자 Git SHA>
apiImage=<sha256 digest>
workerImage=<sha256 digest>
deployedAt=<KST ISO-8601 시각>
dirty=false
```

공식 릴리스는 커밋된 소스에서 빌드해 `dirty=false`여야 합니다. 미커밋 소스를
검증용으로 배포했다면 `dirty=true`로 기록하고 공식 릴리스로 간주하지 않습니다.

## 최초 준비

배포 호스트에 secret 디렉터리를 만듭니다.

```bash
install -d -m 0700 ~/.config/jungle-bell
```

다음 파일을 생성합니다.

- `database-password`
- `pairing-secret` — 32자 이상
- `usage-hash-secret` — 익명 사용량 HMAC 전용, 32자 이상
- `vapid-public-key`
- `vapid-private-key`

secret 디렉터리는 `0700`이어야 합니다. 컨테이너의 non-root JVM이 Docker secret을
읽을 수 있도록 OCI 배포 가이드에 따라 파일 그룹을 런타임 GID로 맞추고 `0640`으로
설정합니다.

운영 환경 파일은 추적되지 않는 `.env.production`으로 만듭니다.

```bash
cp server/deploy/.env.production.example server/deploy/.env.production
chmod 600 server/deploy/.env.production
```

다음 값을 확인하거나 설정합니다.

- `PUBLIC_BASE_URL=https://jungle-bell.sijun-yang.com`
- 다섯 secret 파일의 절대 경로
- `CLOUDFLARE_TUNNEL_TOKEN`
- `LAUNDRY_SOURCE_URL`
- `VAPID_SUBJECT`

`CLOUDFLARE_TUNNEL_TOKEN`, 데이터베이스 비밀번호, pairing secret, usage hash secret,
VAPID private key는 저장소 밖에서 관리합니다.

## Cloudflare named Tunnel 구성

Cloudflare Tunnel의 public hostname을 다음과 같이 설정합니다.

| 항목 | 값 |
| --- | --- |
| Public hostname | `jungle-bell.sijun-yang.com` |
| Service type | `HTTP` |
| Service URL | `api:8080` |

Tunnel token은 `.env.production`의 `CLOUDFLARE_TUNNEL_TOKEN`에만 둡니다. 운영 DNS와
smoke test는 Quick Tunnel URL을 사용하지 않습니다.

## 일반 배포

먼저 [OCI 운영 서버 배포의 소스와 환경 파일 전송](deploy/guide_oci_production_deployment.md#1-소스와-환경-파일-전송)을
실행합니다. 이 단계는 최초 배포뿐 아니라 모든 배포에서 필수입니다. 로컬 환경 파일의
전송이나 설정 검증이 실패하면 이미지 빌드와 컨테이너 교체를 시작하지 않습니다.

로컬 환경 파일을 전송한 뒤 서버에서 Compose 설정을 검증합니다. 운영 Compose는 필수
변수가 없거나 빈 문자열이면 기본값을 사용하지 않고 즉시 실패합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  config --quiet
```

API와 Worker 이미지를 순차적으로 빌드한 뒤 전체 운영 stack을 갱신합니다. API
readiness가 통과한 뒤 Worker와 Tunnel이 시작됩니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  build api
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  build worker
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d
```

Compose 프로젝트명과 PostgreSQL volume 이름을 변경하는 최초 전환에서는 기존
volume이 자동 연결된다고 가정하지 않습니다. 필요한 공개 급식·세탁 기록을 먼저
`pg_dump`로 백업하고, 새 volume에 restore한 결과를 확인한 뒤 이전 stack을
중지합니다.

## 임시 Quick Tunnel

named Tunnel 장애를 분리해서 확인할 때만 Quick Tunnel을 일시적으로 실행합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  --profile quick-tunnel up quick-tunnel
```

출력된 임시 URL은 배포 설정, 데스크톱 빌드, DNS, 운영 문서에 기록하지 않습니다.
확인이 끝나면 `Ctrl-C`로 종료합니다.

## 데이터 확인

```bash
docker exec jungle-bell-postgres psql -U jungle_bell -d jungle_bell -c '
SELECT
  (SELECT count(*) FROM meal_post) AS meal_posts,
  (SELECT count(*) FROM meal_image) AS meal_images,
  (SELECT count(*) FROM minute_observation) AS minute_observations;'
```

## 사용량 수집과 집계 확인

사용량 원자료는 API 요청 thread가 동기식으로 기록합니다. Worker는 원자료 ingestion이
아니라 일별 요약과 보존기간 삭제를 담당합니다. 다음 절차에서는 계정 UUID, 익명 HMAC,
lease token을 출력하지 않습니다.

먼저 API readiness와 공개 사용량 상태를 확인합니다.

```bash
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/health/readiness
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/info
```

readiness는 `readinessState`와 `db`를 포함하지만 `show-details=never`이므로 정상 응답은
전체 `UP`만 확인합니다. `/actuator/info`의 `usageMetrics`는 다음처럼 판정합니다.

- `configured=true`: API 전역 수집 설정이 켜져 있음
- `database=available`: API가 집계 성공 marker를 조회할 수 있음
- `aggregation=never`: 성공 marker가 아직 없음
- `aggregation=fresh`: 마지막 성공이 130분 이내
- `aggregation=stale`: 마지막 성공이 130분보다 오래됨
- `aggregation=unavailable`: marker 조회 실패
- `lastSuccessfulAggregationAt`: marker가 있을 때의 Worker 전체 완료 시각

이 endpoint에는 사용량 수치, UUID, HMAC, 원자료 최근 시각이 나오지 않습니다. 또한
`configured`는 API 설정만 나타냅니다. API와 Worker가 같은
`USAGE_METRICS_ENABLED`를 받는지는 배포 환경 파일과 Compose 설정으로 별도 확인합니다.

네 사용량 테이블의 행 수와 날짜 범위를 aggregate로 확인합니다.

```bash
docker exec jungle-bell-postgres psql -U jungle_bell -d jungle_bell -c "
SELECT source_table, row_count, oldest_usage_date, newest_usage_date
FROM (
  SELECT 'usage_anonymous_day' AS source_table, count(*) AS row_count,
         min(usage_date) AS oldest_usage_date, max(usage_date) AS newest_usage_date
  FROM usage_anonymous_day
  UNION ALL
  SELECT 'usage_user_day', count(*), min(usage_date), max(usage_date)
  FROM usage_user_day
  UNION ALL
  SELECT 'usage_feature_day', count(*), min(usage_date), max(usage_date)
  FROM usage_feature_day
  UNION ALL
  SELECT 'usage_daily_summary', count(*), min(usage_date), max(usage_date)
  FROM usage_daily_summary
) usage_inventory
ORDER BY source_table;"
```

최근 원자료는 client와 허용 코드 단위로만 집계해 확인합니다.

```bash
docker exec jungle-bell-postgres psql -U jungle_bell -d jungle_bell -c "
SELECT usage_date, raw_kind, client, metric_code, unique_subjects, total_count
FROM (
  SELECT usage_date, 'anonymous_activity' AS raw_kind, client,
         activity AS metric_code, count(*) AS unique_subjects, count(*) AS total_count
  FROM usage_anonymous_day
  GROUP BY usage_date, client, activity
  UNION ALL
  SELECT usage_date, 'authenticated_activity', client,
         activity, count(*), count(*)
  FROM usage_user_day
  GROUP BY usage_date, client, activity
  UNION ALL
  SELECT usage_date, 'authenticated_feature', client,
         feature_code, count(*), sum(use_count)
  FROM usage_feature_day
  GROUP BY usage_date, client, feature_code
) raw_usage
WHERE usage_date >=
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date - 7
ORDER BY usage_date DESC, raw_kind, metric_code, client;"
```

최근 요약 수치와 실제 계산 시각은 식별자 없이 조회합니다.

```bash
docker exec jungle-bell-postgres psql -U jungle_bell -d jungle_bell -c "
SELECT usage_date, audience, metric_kind, client, metric_code,
       unique_subjects, total_count,
       to_char(
         to_timestamp(calculated_at_epoch_ms / 1000.0) AT TIME ZONE 'UTC',
         'YYYY-MM-DD HH24:MI:SS.MS UTC'
       ) AS calculated_at
FROM usage_daily_summary
WHERE usage_date >=
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date - 7
ORDER BY usage_date DESC, audience, metric_kind, metric_code, client;"
```

집계 lease와 성공 marker는 `run_token`을 제외하고 조회합니다.

```bash
docker exec jungle-bell-postgres psql -U jungle_bell -d jungle_bell -c "
SELECT name,
       to_char(
         to_timestamp(last_run_at_epoch_ms / 1000.0) AT TIME ZONE 'UTC',
         'YYYY-MM-DD HH24:MI:SS.MS UTC'
       ) AS state_at,
       round(
         (
           extract(epoch FROM (clock_timestamp() - to_timestamp(last_run_at_epoch_ms / 1000.0)))
           / 60.0
         )::numeric,
         1
       ) AS age_minutes
FROM maintenance_state
WHERE name IN ('usage-daily-summary-v1', 'usage-daily-summary-v1:success')
ORDER BY name;"
```

`usage-daily-summary-v1` 시각은 lease 획득 시각이고 완료 시각이 아닙니다.
`usage-daily-summary-v1:success`는 대상 scope 재집계와 네 테이블의 보존기간 삭제가 모두
끝난 뒤에만 갱신됩니다. 전역 수집이 꺼져도 삭제가 성공하면 success marker는
갱신됩니다. success marker가 오래됐다면 요약 생성뿐 아니라 보존기간 삭제도 지연됐을
수 있습니다.

Worker와 사용량 기록 로그를 확인합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 3h worker | grep -F 'Usage aggregation job'
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 30m api | grep -E 'Usage metric recording|Anonymous usage metric'
```

- 같은 `jobRunId`의 `started` 뒤 `completed`가 있으면 재집계·삭제·success marker
  갱신까지 끝났습니다.
- `skipped`는 다른 instance 또는 아직 유효한 55분 lease 때문에 실행하지 않은 것입니다.
- `failed`는 success marker를 갱신하지 않은 실패입니다. stack trace와 DB 상태를 함께
  확인합니다.
- API의 `temporarily unavailable` 경고는 UI 열기 요청이 `503 Retry-After: 1`을 반환한
  경우입니다.
- 기능 메트릭의 `recording failed` 경고는 메트릭만 생략했다는 뜻입니다. 이미 성공한
  업무 응답은 유지됩니다.

실제 트래픽을 확인할 때는 위 테이블 inventory를 기록한 뒤 정상 릴리스 클라이언트에서
평소 UI 열기나 허용된 업무 동작을 수행하고 같은 aggregate 조회를 다시 실행합니다.
UI 열기는 계정·client·날짜별로 중복 제거되므로 같은 주체가 같은 날 다시 열면 행 수가
늘지 않을 수 있습니다. 기능 메트릭은 성공 횟수를 `use_count`에 누적하므로 요약의
`total_count`는 다음 Worker 완료 뒤 반영됩니다.

다음 항목은 단독으로 실제 트래픽을 증명하지 않습니다.

- UI 열기 `204`: 신규 기록, 중복 제거, 전역 비활성화, 계정 `null`·`false`, 익명 거부
  중 어느 결과인지 구분하지 않음
- `aggregation=fresh` 또는 최신 success marker: Worker 후처리가 성공했다는 뜻이며
  신규 원자료가 있었다는 뜻이 아님
- `calculated_at` 갱신: 해당 요약 scope를 다시 계산했다는 뜻이며 특정 요청의 기록을
  증명하지 않음
- 2일·7일·30일·730일 cutoff: Worker 삭제 정책이며 그 기간의 데이터 존재를 보장하는
  가용성 SLA가 아님

수집 여부는 전역 설정, 해당 계정 또는 익명 preference, API 응답·경고 로그, 원자료
aggregate 변화, Worker 완료와 요약 계산 시각을 함께 확인해 판정합니다.

## 배포 확인

모든 외부 검증은 공식 origin에서 실행합니다.

```bash
curl --fail --silent https://jungle-bell.sijun-yang.com/ >/dev/null
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/health/readiness
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/info
curl --fail --silent https://jungle-bell.sijun-yang.com/api/health
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/status
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/laundry
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/meals
server/tools/smoke-api.sh https://jungle-bell.sijun-yang.com
```

스모크 스크립트는 임시 PC 계정을 만든 뒤 인증된
`DELETE /api/desktop/installations/current`로 계정과 종속 데이터를 삭제합니다. 실패
중단 시에도 같은 삭제를 시도하므로 로컬 PostgreSQL container 접근에 의존하지 않습니다.

다음 항목도 확인합니다.

- 일반 브라우저와 설치 PWA에서 SPA 최초 접속, hash 경로 직접 접속, 새로고침
- 공개 API와 immutable 급식 이미지 URL이 같은 origin을 사용하는지
- PC 등록, WebView session, pairing 생성·claim·승인·완료
- 릴리스 Desktop 앱의 서버 연결과 출석 snapshot 동기화
- PWA Push subscription 등록, 테스트 알림 수신, 구독 해제
- Worker의 세탁·급식 수집과 `lastSuccessAt`, `consecutiveFailures`
- Cloudflare를 통과한 요청에서 enrollment rate limit이 `CF-Connecting-IP`를 client
  key로 사용하는지

실행 상태와 최근 로그도 함께 확인합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  ps
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 10m api worker tunnel postgres
```

특정 HTTP 요청이나 Worker 실행을 추적할 때는 응답의 `X-Request-ID` 또는 로그의
`jobRunId`로 필터링합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 30m api | grep -F 'requestId=<REQUEST_ID>'
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 30m worker | grep -F 'jobRunId=<JOB_RUN_ID>'
```

배포 검증에서는 API와 Worker 로그에 token 또는 인증 header 원문이 없는지도 확인합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 30m api worker | grep -E 'jbd_|jbs_|jbui_|jbcr_|Authorization:|Cookie:'
```

마지막 명령은 일치 항목을 출력하지 않아야 합니다.

## 롤백

API 문제이면 직전 tag를 `API_IMAGE`, Worker 문제이면 `WORKER_IMAGE`에 지정하고 해당
서비스만 다시 생성합니다. schema가 바뀌었다면 이미지 호환성을 추측하지 말고 검증된
PostgreSQL backup으로 새 volume을 준비합니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d --no-deps --force-recreate api
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d --no-deps --force-recreate worker
```
