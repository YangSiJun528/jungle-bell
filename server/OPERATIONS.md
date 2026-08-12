# Server operations

이 문서는 App Worker와 OCI Jobs의 현재 배포·복구 절차입니다. 명령은 별도 표기가
없으면 `server/`에서 실행합니다.

## 운영 구성

| 구성 요소 | 위치 | 역할 |
| --- | --- | --- |
| App Worker | Cloudflare | HTTP API, 고정 D1/R2 gateway와 대시보드·PWA·Markdown 블로그 자산 |
| OCI Jobs | OCI Docker | 수집, 알림 계획, housekeeping, Web Push |
| D1 | Cloudflare | 공개 조회 모델과 개인·알림 상태 |
| R2 | Cloudflare | 수집 원본·정규화본·이미지·Jobs 실행 로그 |

App Worker에는 Cron Trigger, Push relay Service Binding, VAPID private key가 없어야
합니다. OCI Jobs의 D1/R2 작업은 App Worker의 인증된 `/internal/jobs/d1`,
`/internal/jobs/r2`를 거쳐 고정 `DB`, `DATA_BUCKET` binding에서 실행됩니다. OCI에는
D1 관리 자격 증명, database 식별자 또는 R2 S3 자격 증명을 배포하지 않습니다.

OCI Jobs는 Supercronic이 매분 `jobs run`을 시작하고 `flock --nonblock`이 중첩 실행을
막습니다. 같은 cycle 안에서 다음 단계를 순서대로 실행합니다.

```text
collector → attendance → meals → laundry → housekeeping → push
```

한 단계가 실패해도 나머지 단계는 계속 실행합니다. cycle 중 하나라도 실패하면
프로세스 exit code는 1이고 R2 `logs/jobs-runs/`에 실패 로그를 남깁니다.

## 배포 전 확인

```bash
npm --prefix .. ci
npm ci
npm --prefix .. run verify:web
npm --prefix .. run verify:server
```

다음 조건을 확인합니다.

- `apps/api-worker/deploy/wrangler.api.jsonc`의 D1 ID가 영(0) UUID나 기존 `jungle-bell-data` ID가 아님
- production/test App Worker의 `DB`·`DATA_BUCKET` binding이 서로 격리됨
- OCI Jobs의 gateway URL과 R2 bucket이 대상 환경의 고정값과 일치함
- App Worker와 OCI Jobs의 `JOBS_D1_GATEWAY_SECRET` 값이 같고 32자 이상임
- App Worker와 OCI Jobs의 VAPID public key가 같음
- OCI Jobs에만 VAPID private key가 있음
- `database/schema.sql`을 기존 또는 사용 중인 D1에 실행하지 않음
- Cloudflare edge에서 mutating `/api/*`, 특히 desktop 등록과 페어링 경로의 rate
  rule이 활성화되어 있고 경보·로그를 확인할 수 있음

`database/schema.sql`은 모든 앱 테이블을 다시 만드는 신규 D1 전용 bootstrap입니다. 작은
운영 변경은 별도로 검토한 비파괴 SQL을 먼저 준비합니다.

### Desktop UI 세션 D1 마이그레이션

`database/migrations/2026-08-12-desktop-ui-sessions.sql`은 기존 행을 수정하거나 삭제하지
않고 `desktop_ui_session` 테이블과 만료 index만 추가합니다. 직접 HTTP를 사용하는 App
Worker와 신규 housekeeping을 포함한 OCI Jobs를 배포하기 전에 적용해야 합니다. 순서는
**복구 지점 확인 → migration → OCI Jobs → App Worker → Tauri**입니다. App Worker를 먼저
배포하면 WebView bootstrap이 `500`으로 실패하고, migration 없이 신규 Jobs를 먼저
실행하면 housekeeping 단계가 실패합니다.

아래 명령은 `server/apps/api-worker/`에서 실행합니다.

```bash
# v2-test
npx wrangler d1 time-travel info jungle-bell-v2-test --json
npx wrangler d1 execute jungle-bell-v2-test --remote \
  --file=../../database/migrations/2026-08-12-desktop-ui-sessions.sql
npx wrangler d1 execute jungle-bell-v2-test --remote \
  --command="SELECT origin, scope, count(*) AS count FROM desktop_ui_session GROUP BY origin, scope"

# production: v2-test API와 실제 앱 검증 뒤 실행
npx wrangler d1 time-travel info jungle-bell-v2 --json
npx wrangler d1 execute jungle-bell-v2 --remote \
  --file=../../database/migrations/2026-08-12-desktop-ui-sessions.sql
npx wrangler d1 execute jungle-bell-v2 --remote \
  --command="SELECT origin, scope, count(*) AS count FROM desktop_ui_session GROUP BY origin, scope"
```

검증 쿼리는 token digest를 출력하지 않습니다. `origin`은 허용된 세 값, `scope`는
`desktop-ui-v1`만 나와야 합니다. 롤백 시 구 App Worker는 새 테이블을 읽지 않으므로
테이블을 제거하지 않습니다. 새 코드의 housekeeping은 매 실행마다 만료됐거나 유효한
parent Desktop 소유권이 없는 행을 최대 500개씩 제거합니다.

### 출석 알림 설정 D1 마이그레이션

`database/migrations/2026-08-12-attendance-notification-preferences.sql`은 기존
`attendance_preference` 행을 유지하면서 전체 알림 스위치, 오전 시작·오후 종료 시각,
반복 간격을 추가하는 1회성 비파괴 변경입니다. 기존 사용자는 현재 동작과 호환되는
`enabled=1`, 오전 `09:00`, 오후 `04:00`, 각 `15분`을 기본값으로 받습니다.

신규 코드가 새 열을 즉시 읽으므로 **v2-test 복구 지점 → v2-test 마이그레이션 → v2-test
배포·검증 → production 복구 지점 → production 마이그레이션 → production 배포** 순서를
지킵니다. 구 버전은 새 열을 무시하고 기존 행 생성 시 D1 기본값을 받으므로 DB 변경을
먼저 적용해도 됩니다. SQL은 이미 추가된 열을 자동 판별하지 않으므로 같은 DB에 두 번
실행하지 않습니다.

마이그레이션 뒤에는 **OCI Jobs를 먼저 갱신한 다음** v2 경로와 신규 PWA 자산을 함께
제공하는 App Worker를 배포합니다. 새 Tauri 배포는 그 다음입니다. App Worker를 먼저
배포하면 신규 PWA가 `enabled`·시간·간격을 저장한 직후에도 구 Jobs가 이를 무시하는
짧은 구간이 생기므로 순서를 바꾸지 않습니다. 기존 PC/PWA는 계속
`/attendance/preferences`의 4필드 계약을 사용하고, 신규 클라이언트만
`/v2/attendance/preferences`를 사용하므로 이 순서에서 구·신 클라이언트가 함께
동작합니다. 기존 경로의 PUT은 v2 전용 열을 SQL에서 갱신하지 않습니다.

아래 명령은 `server/apps/api-worker/`에서 실행합니다.

```bash
# v2-test
npx wrangler d1 time-travel info jungle-bell-v2-test --json
npx wrangler d1 execute jungle-bell-v2-test --remote \
  --file=../../database/migrations/2026-08-12-attendance-notification-preferences.sql
npx wrangler d1 execute jungle-bell-v2-test --remote \
  --command="SELECT enabled, morning_start_hour, evening_end_hour, morning_interval_minutes, evening_interval_minutes FROM attendance_preference LIMIT 5"

# production: production D1 ID 설정과 v2-test 검증이 끝난 뒤 실행
npx wrangler d1 time-travel info jungle-bell-v2 --json
npx wrangler d1 execute jungle-bell-v2 --remote \
  --file=../../database/migrations/2026-08-12-attendance-notification-preferences.sql
npx wrangler d1 execute jungle-bell-v2 --remote \
  --command="SELECT enabled, morning_start_hour, evening_end_hour, morning_interval_minutes, evening_interval_minutes FROM attendance_preference LIMIT 5"
```

`time-travel info`가 반환한 bookmark를 배포 기록에 남깁니다. 이 방식은 사용자·알림
데이터를 로컬 파일로 복제하지 않으면서 마이그레이션 직전 D1 상태를 지정합니다. 전체
SQL export에는 개인 데이터가 포함될 수 있으므로 기본 절차로 실행하지 않습니다. 별도
보관이 꼭 필요할 때만 접근 제한된 저장 위치와 담당 승인을 먼저 확정합니다.

검증 쿼리가 새 열을 반환하고 기존 행 수·`morning_enabled`·`evening_enabled`·건너뛰기
값이 유지됐는지 확인한 뒤 App Worker와 OCI Jobs를 배포합니다. 코드 롤백 시 구 버전은
추가 열을 무시하므로 열을 제거하지 않습니다. 데이터 자체를 복구해야 하는 사고에서만
영향 범위와 bookmark 이후 쓰기 손실을 확인한 뒤 다음 명령을 사용합니다.

```bash
npx wrangler d1 time-travel restore jungle-bell-v2-test --bookmark <RECOVERY_BOOKMARK>
```

사용 중인 D1에 bootstrap을 실행하지 않습니다.

### Edge abuse control

무인 desktop 등록과 200대 campus NAT 계약 때문에 App Worker의 D1 fixed-window
제한만으로 분산 IP 기반 quota 소진을 완전히 차단할 수 없습니다. 운영 배포 전
Cloudflare edge에서 mutating `/api/*`를 보호하고, 특히
`POST /api/desktop/installations`, `POST /api/pairings`,
`POST /api/pairings/claims`를 별도로 관찰합니다.

Edge 임계치는 코드의 정상 NAT 계약인 desktop 등록 IP당 240회/10분과 수동 claim IP당 240회/2분보다
낮게 시작하지 않습니다. 배포 후 `429`, pairing `409`, D1 write
추이를 함께 모니터링하고 실제 테스트·운영 트래픽을 근거로 조정합니다. Edge rule은
저장소의 고정 window와 활성 페어링 1개 제한을 대체하지 않는 defense-in-depth입니다.

## App Worker 배포

App Worker secret을 config를 명시해 설정합니다.

```bash
npx wrangler secret put PAIRING_SECRET --config apps/api-worker/deploy/wrangler.api.jsonc
npx wrangler secret put VAPID_PUBLIC_KEY --config apps/api-worker/deploy/wrangler.api.jsonc
npx wrangler secret put JOBS_D1_GATEWAY_SECRET --config apps/api-worker/deploy/wrangler.api.jsonc
npm run deploy:api
```

v2-test에는 별도 값으로 같은 세 secret을 `apps/api-worker/deploy/wrangler.api-test.jsonc`에 설정하고
`npm run deploy:api:test`를 사용합니다. Production secret을 복사하지 않습니다.

배포 스크립트의 predeploy 단계는 production/test에 맞는
`JUNGLE_BELL_PUBLIC_ORIGIN`으로 루트 웹 빌드를 실행합니다. 따라서 대시보드와
`src/site/` Markdown 블로그가 같은 deployment의 Static Assets에 포함되고 canonical과
RSS도 대상 Worker origin을 사용합니다. 별도 블로그 Worker를 배포하지 않습니다.

```bash
npx wrangler deployments list --config apps/api-worker/deploy/wrangler.api.jsonc
curl --fail --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/api/public/status
curl --fail --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/blog/index.html
```

Cloudflare Dashboard에서 `jungle-bell-api`에 Cron Trigger와 Service Binding이 없는지
확인합니다. 정적 자산 또는 HTTP API만 바뀐 배포는 여기서 끝냅니다.

기존 scheduled App Worker에서 처음 전환할 때는 App Worker를 먼저 배포해 Cron을
제거한 다음 OCI Jobs를 시작합니다. 반대 순서는 두 런타임이 같은 Push delivery를
동시에 처리할 수 있으므로 금지합니다.

## OCI Jobs 최초 설정

OCI 경로는 다음을 기준으로 합니다.

- 소스: `/home/ubuntu/jungle-bell/server`
- production secrets: `/home/ubuntu/.config/jungle-bell-jobs`
- production 환경: `/home/ubuntu/jungle-bell/server/apps/jobs-runner/deploy/.env.oci`

구조 변경 전 루트 환경 파일이 남아 있는 기존 호스트는 최초 1회 새 위치로 복사합니다.
새 Compose 설정과 컨테이너를 검증하기 전에는 기존 파일을 삭제하지 않습니다.

```bash
cd /home/ubuntu/jungle-bell/server
install -d -m 700 apps/jobs-runner/deploy
test ! -f .env.oci || test -f apps/jobs-runner/deploy/.env.oci || \
  install -m 600 .env.oci apps/jobs-runner/deploy/.env.oci
test ! -f .env.oci-v2-test || test -f apps/jobs-runner/deploy/.env.oci-v2-test || \
  install -m 600 .env.oci-v2-test apps/jobs-runner/deploy/.env.oci-v2-test
```

신규 v2 D1/R2 binding과 runtime secret을 먼저 준비합니다.

- App Worker와 공유할 32자 이상 gateway secret
- production 전용 VAPID key pair

OCI에서 secret 파일을 만듭니다. 입력값은 shell history나 명령 인자에 넣지 않습니다.

```bash
install -d -m 700 ~/.config/jungle-bell-jobs

read -rsp 'Jobs D1 gateway secret (32+ chars): ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-jobs/jobs-d1-gateway-secret
unset VALUE

read -rsp 'VAPID public key: ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-jobs/vapid-public-key
unset VALUE

read -rsp 'VAPID private key: ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-jobs/vapid-private-key
unset VALUE

chmod 600 ~/.config/jungle-bell-jobs/*
```

production 환경 파일을 만들고 VAPID subject와 장기 운영할 HTTPS
`LAUNDRY_URL`을 입력합니다. production에서는 임시 tunnel URL을 사용하지 않습니다.
v2-test가 내부 전용 세탁 서비스에 접근하기 위해 사용하는 `trycloudflare.com`
tunnel은 의도된 구성이고 배포 결함이 아닙니다. Gateway URL은 production 고정값을
유지하며 Secret 원문은 환경 파일에 넣지 않습니다.

```bash
cd /home/ubuntu/jungle-bell/server
test -f apps/jobs-runner/deploy/.env.oci || \
  cp apps/jobs-runner/deploy/.env.oci.example apps/jobs-runner/deploy/.env.oci
chmod 600 apps/jobs-runner/deploy/.env.oci
```

## OCI Jobs 배포

로컬 소스를 동기화합니다. OCI의 환경 파일과 secret은 제외합니다.

```bash
COPYFILE_DISABLE=1 rsync -az --delete \
  -e 'ssh -i ~/.ssh/oci_a1_flex' \
  --exclude '.env' \
  --exclude '.dev.vars' \
  --exclude '.env.oci' \
  --exclude '.env.oci-v2-test' \
  --exclude 'apps/jobs-runner/deploy/.env.oci' \
  --exclude 'apps/jobs-runner/deploy/.env.oci-v2-test' \
  --exclude '.wrangler/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  --exclude '._*' \
  ./ ubuntu@oci-server:/home/ubuntu/jungle-bell/server/
```

`server/.dockerignore`는 `.dev.vars`, `.env`, `.env.*`를 build context에서 모두
제외합니다. 환경 예시는 배포 설정용이며 Dockerfile이 복사하지 않습니다. 실제
Wrangler secret 파일을 OCI로 전송하거나 Docker image layer에 포함하지 않습니다.

현재 이미지를 보존한 뒤 Jobs service만 교체합니다.

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server '
  set -eu
  cd /home/ubuntu/jungle-bell/server
  docker image inspect jungle-bell-jobs:latest >/dev/null 2>&1 \
    && docker tag jungle-bell-jobs:latest jungle-bell-jobs:rollback \
    || true
  docker compose --env-file apps/jobs-runner/deploy/.env.oci \
    -f apps/jobs-runner/deploy/docker-compose.oci.yml config --quiet
  docker compose --env-file apps/jobs-runner/deploy/.env.oci \
    -f apps/jobs-runner/deploy/docker-compose.oci.yml build jobs
  docker compose --env-file apps/jobs-runner/deploy/.env.oci \
    -f apps/jobs-runner/deploy/docker-compose.oci.yml up -d jobs
  docker compose --env-file apps/jobs-runner/deploy/.env.oci \
    -f apps/jobs-runner/deploy/docker-compose.oci.yml ps jobs
'
```

같은 호스트의 다른 Compose project나 컨테이너를 prune·재시작하지 않습니다.

## 배포 검증

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server \
  'docker logs --since 10m jungle-bell-jobs'

curl --fail --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/api/health
```

다음을 확인합니다.

- `jungle-bell-jobs`가 `Up`
- 매분 cycle이 시작되고 같은 분에 중복 실행되지 않음
- 세탁은 매분, 급식 두 source는 5분마다 수집됨
- production `LAUNDRY_URL`이 임시 tunnel이 아닌 운영 HTTPS endpoint를 가리킴.
  v2-test의 내부 서비스용 `trycloudflare.com` tunnel은 정상 구성으로 취급함
- Jobs 로그의 `failed`가 비어 있음
- D1/R2 gateway에 `401`, `429`, `5xx`가 없음
- `/api/health`가 `200`
- 테스트 알림이 다음 Jobs tick 뒤 모든 활성 PWA Push와 PC inbox에 도착함

## v2-test 병렬 실행

테스트는 `apps/jobs-runner/deploy/docker-compose.oci-v2-test.yml`과
`apps/jobs-runner/deploy/.env.oci-v2-test`만 사용합니다. Runtime
검증은 gateway를
`https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1`로 고정하고
같은 test Worker의 `DATA_BUCKET` binding만 사용합니다. 별도 image/container와 secret 디렉터리를
사용하며 production secret을 복사하거나 mount하지 않습니다.
내부 전용 세탁 서비스에 접근하는 `LAUNDRY_URL`은 `trycloudflare.com` tunnel을
사용할 수 있으며, 주소가 실제로 응답하면 임시 도메인이라는 이유만으로 실패 처리하지 않습니다.

```bash
test -f apps/jobs-runner/deploy/.env.oci-v2-test || \
  cp apps/jobs-runner/deploy/.env.oci-v2-test.example apps/jobs-runner/deploy/.env.oci-v2-test
chmod 600 apps/jobs-runner/deploy/.env.oci-v2-test

docker compose --project-name jungle-bell-v2-test \
  --env-file apps/jobs-runner/deploy/.env.oci-v2-test \
  -f apps/jobs-runner/deploy/docker-compose.oci-v2-test.yml config --quiet
docker compose --project-name jungle-bell-v2-test \
  --env-file apps/jobs-runner/deploy/.env.oci-v2-test \
  -f apps/jobs-runner/deploy/docker-compose.oci-v2-test.yml build jobs-v2-test
docker compose --project-name jungle-bell-v2-test \
  --env-file apps/jobs-runner/deploy/.env.oci-v2-test \
  -f apps/jobs-runner/deploy/docker-compose.oci-v2-test.yml up -d jobs-v2-test
```

중지할 때도 project와 service를 명시합니다.

```bash
docker compose --project-name jungle-bell-v2-test \
  --env-file apps/jobs-runner/deploy/.env.oci-v2-test \
  -f apps/jobs-runner/deploy/docker-compose.oci-v2-test.yml stop jobs-v2-test
```

테스트 Worker의 2026-08-04 이전 deployment는 운영 D1/R2 binding을 포함합니다.
해당 버전으로 rollback하지 않습니다.

## 롤백

현재 HTTP-only App Worker 버전끼리는 Wrangler deployment 이력으로 롤백합니다.

```bash
npx wrangler deployments list --config apps/api-worker/deploy/wrangler.api.jsonc
npx wrangler rollback <VERSION_ID> --name jungle-bell-api --yes
```

Cron이 있던 과거 App Worker로 되돌려야 한다면 먼저 OCI Jobs를 중지합니다. 그렇지
않으면 Push와 lifecycle이 중복 실행됩니다. 테스트 Worker는 후보 version binding을
확인해 test D1/R2만 가리키는 버전으로만 롤백합니다.

OCI Jobs는 보존한 image로 되돌립니다.

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server '
  set -eu
  cd /home/ubuntu/jungle-bell/server
  docker tag jungle-bell-jobs:rollback jungle-bell-jobs:latest
  docker compose --env-file apps/jobs-runner/deploy/.env.oci \
    -f apps/jobs-runner/deploy/docker-compose.oci.yml \
    up -d --no-build --force-recreate jobs
'
```

D1 schema와 R2 객체는 코드 rollback으로 되돌아가지 않습니다. Schema 변경에는
되돌릴 비파괴 SQL 또는 새 blue/green 리소스를 준비합니다.

## 장애 확인 순서

1. `jungle-bell-jobs` 실행 여부와 최근 cycle 로그
2. 원본 세탁·급식 요청 오류
3. App Worker D1 gateway 인증·timeout·batch 오류
4. App Worker R2 gateway 인증·key allowlist·크기 제한 오류
5. Web Push provider 오류와 retry/gone 처리
6. App Worker의 D1/R2 조회 오류

App Worker는 HTTP-only이므로 Jobs 장애 중에도 로그인·설정·PC snapshot 업로드를
받을 수 있습니다. 다만 공개 데이터 freshness와 새 알림 전송은 Jobs가 복구될 때까지
지연됩니다.
