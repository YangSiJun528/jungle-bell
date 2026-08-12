# 서버 환경과 바인딩 레퍼런스

Jungle Bell 서버 패키지는 HTTP 전용 App Worker와 주기 작업 전용 OCI Jobs로 실행됩니다. 두 런타임은 같은 환경의 D1/R2 상태를 사용하며 하나의 환경별 gateway secret만 공유합니다.

## App Worker

| 이름 | 종류 | 용도 |
| --- | --- | --- |
| `DB` | D1 binding | 공개 조회 모델, session, pairing, 출석, 개인 설정, 알림 delivery와 OCI gateway의 고정 대상 |
| `DATA_BUCKET` | R2 binding | 정규화 자료와 급식 이미지 조회 |
| `PAIRING_SECRET` | Worker secret | QR·10자리 코드 연결. 32바이트 이상 난수 |
| `VAPID_PUBLIC_KEY` | Worker secret | PWA 구독 생성에 공개할 VAPID public key |
| `JOBS_D1_GATEWAY_SECRET` | Worker secret | `/internal/jobs/d1`, `/internal/jobs/r2`의 OCI Jobs bearer. 32자 이상 |

App Worker는 fetch handler와 Static Assets만 제공합니다. Cron Trigger, Service Binding, VAPID private key를 설정하지 않습니다. 웹 자산과 `/api`, `/internal/jobs/*`는 같은 Worker origin에서 제공됩니다.

`PAIRING_SECRET`이 없으면 새 pairing은 `503 PAIRING_SERVICE_UNAVAILABLE`로 거부됩니다. `VAPID_PUBLIC_KEY`가 없으면 Push 공개키 조회와 구독 등록은 `503 WEB_PUSH_NOT_CONFIGURED`로 거부됩니다. `JOBS_D1_GATEWAY_SECRET`이 없으면 gateway만 `503 D1_GATEWAY_NOT_CONFIGURED`를 반환합니다.

`/internal/jobs/d1`과 `/internal/jobs/r2`는 요청자가 D1 또는 R2 대상을 선택할 수 없는 고정 `DB`, `DATA_BUCKET` binding gateway입니다. OCI Jobs와 App Worker에는 같은 환경의 gateway secret을 설정하되 production과 v2-test 사이에는 재사용하지 않습니다.

### 빌드 시 공개 origin

`JUNGLE_BELL_PUBLIC_ORIGIN`은 Worker runtime 변수가 아니라 대시보드·Markdown 사이트 빌드 변수입니다. canonical URL과 RSS origin에 사용됩니다.

| 배포 | 값 |
| --- | --- |
| production | `https://jungle-bell-api.yangsijun5528.workers.dev` |
| v2-test | `https://jungle-bell-api-test.yangsijun5528.workers.dev` |

`deploy:api`와 `deploy:api:test`의 predeploy 단계는 각 origin으로 루트 웹 빌드를 실행해야 합니다.

## OCI Jobs

### 실행 환경과 Worker gateway

| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `JUNGLE_BELL_ENVIRONMENT` | 예 | `production` 또는 `v2-test`. Compose가 고정 |
| `JOBS_D1_GATEWAY_URL` | 예 | 환경별 고정 HTTPS `/internal/jobs/d1` endpoint |
| `JOBS_D1_GATEWAY_SECRET_FILE` | 예 | App Worker와 같은 32자 이상 shared secret 파일 |
| `D1_GATEWAY_TIMEOUT_MS` | 아니요 | D1/R2 gateway 요청 제한 시간. 기본 `30000` |
| `D1_GATEWAY_RETRIES` | 아니요 | 명백한 D1 `SELECT`와 R2 gateway의 network, `429`, `5xx` 재시도 횟수. D1 쓰기 및 쓰기가 섞인 batch는 재시도하지 않음. 기본 `3` |

OCI Jobs에는 D1 관리 자격 증명이나 database 식별자를 배포하지 않습니다. 모든 D1 query와 batch는 `JOBS_D1_GATEWAY_URL`의 App Worker를 거쳐 해당 Worker의 고정 `DB` binding에서 실행됩니다. R2 gateway URL은 같은 origin의 `/internal/jobs/r2`로 파생합니다.

### R2

OCI Jobs는 수집 원본·정규화본·이미지와 `logs/jobs-runs/` 실행 로그를 인증된 App
Worker gateway에 raw body로 전송합니다. Worker가 환경별 고정 `DATA_BUCKET` binding을
사용하므로 OCI에는 R2 endpoint, bucket 이름, access key 또는 secret key를 설정하지
않습니다. Gateway는 Jobs가 생성하는 key prefix와 콘텐츠 유형만 허용하고 객체당
16 MiB를 상한으로 둡니다.

### Web Push

| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY_FILE` | 예 | App Worker의 `VAPID_PUBLIC_KEY`와 같은 public key 파일 |
| `VAPID_PRIVATE_KEY_FILE` | 예 | OCI Jobs에만 두는 private key 파일 |
| `VAPID_SUBJECT` | 예 | `mailto:` 또는 HTTPS contact URI |

Private key는 OCI secret 파일에만 저장하며 Worker secret, D1, R2, 저장소 파일에 넣지 않습니다. OCI Jobs는 pending delivery를 최대 100개씩 전송합니다. Push provider의 `404` 또는 `410` 응답이면 구독과 남은 delivery를 폐기하고, 그 밖의 실패는 backoff 계약에 따라 재시도합니다.

### 수집

| 이름 | 기본값 또는 용도 |
| --- | --- |
| `MEALS_EVERY_MINUTES` | `5`. 세탁은 매분 수집 |
| `LAUNDRY_URL` | 필수 HTTPS 세탁 상태 원본 URL. 임시 tunnel 기본값 없음 |
| `MEALS_INCLUDE_PINNED_URL` | pinned 포함 카카오 API |
| `MEALS_DEFAULT_URL` | 기본 카카오 API |
| `MEALS_PAGE_URL` | 게시물 permalink 기준 URL |
| `REQUEST_TIMEOUT_MS` | 원본 요청 제한 시간. 기본 `30000` |
| `REQUEST_RETRIES` | 원본 요청 재시도 횟수. 기본 `2` |
| `LG_RUN_STATES` | 선택적 LG running state 목록 |

## 고정 배포 대상

| 환경 | D1 gateway | App Worker `DB` | R2 | OCI identity |
| --- | --- | --- | --- | --- |
| production | `https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1` | `jungle-bell-v2` | `jungle-bell-v2` | `jungle-bell-jobs` |
| v2-test | `https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1` | `jungle-bell-v2-test` | `jungle-bell-v2-test` | `jungle-bell-jobs-v2-test` |

`loadJobsConfiguration`은 environment와 gateway URL 조합이 이 표와 다르면 시작을 거부합니다. v2-test는 별도 image, container, 환경 파일, secret 디렉터리를 사용합니다. `PAIRING_SECRET`, gateway secret과 VAPID key pair도 production/test 사이에 재사용하지 않습니다.

## Secret 파일과 로컬 개발

운영 Compose는 다음 세 파일만 read-only로 mount합니다.

- `jobs-d1-gateway-secret`
- `vapid-public-key`
- `vapid-private-key`

Secret 디렉터리는 `0700`, 각 파일은 `0600`으로 관리합니다. `.env.oci`와 `.env.oci-v2-test`에는 secret 원문을 넣지 않습니다.

Wrangler 로컬 개발은 `server/.dev.vars.example`을 `.dev.vars`로 복사해 `PAIRING_SECRET`, `VAPID_PUBLIC_KEY`, `JOBS_D1_GATEWAY_SECRET`을 설정합니다. `.dev.vars`는 Git, OCI rsync, Docker build context에서 제외합니다. 실제 secret 값은 명령 인자, 테스트 fixture, 로그에 기록하지 않습니다.

API Worker는 LMS ID, access token, refresh token, cookie를 입력으로 받거나 저장하지 않습니다.
