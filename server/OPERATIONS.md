# Server operations

이 문서는 Jungle Bell 서버의 내부 운영 런북입니다. 사용자용 문서가 아니며, 배포와 복구에 필요한 현재 절차만 유지합니다. 실행 이력은 별도 문서로 누적하지 않고 Git과 Cloudflare 배포 이력, OCI 컨테이너 로그를 사용합니다.

## 운영 구성

| 구성 요소 | 실행 위치 | 역할 |
| --- | --- | --- |
| Collector | OCI Docker | 세탁실은 매분, 카카오 급식 API 두 개는 5분마다 순차 수집 |
| D1 | Cloudflare | 상태, 분 단위 관측, 세탁 이벤트, 식단 조회 모델의 기준 저장소 |
| R2 | Cloudflare | 원본 JSON, 정규화본, 이미지, 수집 commit과 실행 로그 보관 |
| API Worker | Cloudflare | D1/R2를 읽는 공개 HTTP API |

Cloudflare Collector Worker와 Ingest Worker는 사용하지 않습니다. API Worker에도 Cron Trigger가 없어야 합니다. OCI의 n8n과 BOINC는 이 서비스의 배포 대상이 아닙니다.

주요 경로는 다음과 같습니다.

- 로컬 소스: `server/`
- OCI 배포 경로: `/home/ubuntu/jungle-bell/server`
- OCI Secret: `/home/ubuntu/.config/jungle-bell-collector`
- Cloudflare 설정: `wrangler.api.jsonc`
- OCI 설정: `docker-compose.oci.yml`, `.env.oci`

## 배포 원칙

- Secret 원문을 저장소, `.env.oci`, 명령 인자, 로그에 기록하지 않습니다.
- 운영 D1에서는 `npm run db:reset:remote`를 실행하지 않습니다. 이 명령은 모든 D1 데이터를 삭제합니다.
- API Worker의 Cron Trigger는 설정 파일에서 제거해도 기존 트리거가 남을 수 있으므로 배포 후 별도로 확인합니다.
- OCI 이미지를 다시 빌드하기 전에 현재 이미지를 `jungle-bell-collector:rollback`으로 보존합니다.
- Collector 배포는 `jungle-bell-collector`만 변경합니다. 같은 호스트의 다른 컨테이너를 일괄 정리하지 않습니다.

## 정상 배포

### 1. 로컬 검증

저장소의 `server` 디렉터리에서 실행합니다.

```bash
npm ci
npm run check
npm run build
```

스키마 변경이 포함되면 코드 배포 전에 운영 D1에 필요한 SQL을 별도로 적용하고 `schema.sql`도 같은 변경에 맞춥니다. 현재 자동 마이그레이션은 없습니다.

### 2. API Worker 배포

```bash
npm run deploy:api
curl --fail --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/healthz
```

Cloudflare Dashboard의 `jungle-bell-api` Triggers에서 Cron 목록이 비어 있는지 확인합니다. Cron이 남아 있으면 모두 제거합니다. `jungle-bell-collector` Worker는 존재하지 않아야 합니다.

API만 변경한 배포는 여기서 끝냅니다. Collector 코드나 의존성이 변경된 경우에만 OCI 배포를 계속합니다.

### 3. OCI 소스 동기화

로컬 `server` 디렉터리에서 실행합니다. `oci-server`는 로컬 SSH 설정 또는 Tailscale MagicDNS로 해석되어야 합니다.

```bash
COPYFILE_DISABLE=1 rsync -az --delete \
  -e 'ssh -i ~/.ssh/oci_a1_flex' \
  --exclude '.env' \
  --exclude '.env.oci' \
  --exclude '.wrangler/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  --exclude '._*' \
  ./ ubuntu@oci-server:/home/ubuntu/jungle-bell/server/
```

`.env.oci`와 Secret은 동기화 대상에서 제외되어 서버의 기존 값을 유지합니다.

### 4. OCI Collector 배포

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server '
  set -eu
  cd /home/ubuntu/jungle-bell/server
  docker image inspect jungle-bell-collector:latest >/dev/null 2>&1 \
    && docker tag jungle-bell-collector:latest jungle-bell-collector:rollback \
    || true
  docker compose --env-file .env.oci -f docker-compose.oci.yml config --quiet
  docker compose --env-file .env.oci -f docker-compose.oci.yml build
  docker compose --env-file .env.oci -f docker-compose.oci.yml up -d
  docker compose --env-file .env.oci -f docker-compose.oci.yml ps
'
```

이미지는 OCI A1 Flex의 `arm64`에서 빌드됩니다. Supercronic이 매분 실행하고 `flock`이 이전 실행과 겹치는 것을 막습니다.

### 5. 배포 검증

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server \
  'docker logs --since 10m jungle-bell-collector'

curl --fail --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/healthz
```

다음을 확인합니다.

- `jungle-bell-collector`가 `Up` 상태임
- 매분 `laundry`가 한 번 실행되고 `status: SUCCESS`임
- UTC 분이 5의 배수일 때만 `meals-include-pinned`, `meals-default`가 순서대로 실행됨
- D1에 `401`, `403`, `429` 오류가 없음
- R2에 `AccessDenied`, `NoSuchBucket` 오류가 없음
- `/healthz`가 `200 OK`이고 세 소스의 `consecutiveFailures`가 `0`임
- R2 실행 로그에 같은 분의 중복 실행이 없음
- n8n과 BOINC 컨테이너가 계속 실행 중임

## 최초 설정과 Secret 교체

Cloudflare 리소스 생성과 D1 초기화는 새 환경에서만 실행합니다.

```bash
npx wrangler d1 create jungle-bell-data
npx wrangler r2 bucket create jungle-bell-data
npm run db:reset:remote
```

D1 생성 결과의 ID를 `wrangler.api.jsonc`와 `.env.oci`에 동일하게 설정합니다.

OCI에는 다음 최소 권한 자격증명만 설치합니다.

- Cloudflare API Token: 대상 계정의 `D1 Write`
- R2 S3 자격증명: `jungle-bell-data` 버킷의 Object Read & Write

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server
install -d -m 700 ~/.config/jungle-bell-collector

read -rsp 'Cloudflare D1 API token: ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-collector/cloudflare-d1-api-token
unset VALUE

read -rsp 'R2 access key ID: ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-collector/r2-access-key-id
unset VALUE

read -rsp 'R2 secret access key: ' VALUE; echo
printf '%s' "$VALUE" > ~/.config/jungle-bell-collector/r2-secret-access-key
unset VALUE

chmod 600 ~/.config/jungle-bell-collector/*
```

배포 환경 파일은 최초 한 번 생성합니다.

```bash
cd /home/ubuntu/jungle-bell/server
cp .env.oci.example .env.oci
chmod 600 .env.oci
```

자격증명을 교체한 뒤에는 Collector 컨테이너를 다시 생성하고 정상 수집을 확인한 다음 기존 토큰을 폐기합니다.

## 롤백

API Worker 배포 이력을 확인하고 이전 버전으로 되돌립니다.

```bash
npx wrangler deployments list --name jungle-bell-api
npx wrangler rollback <VERSION_ID> --name jungle-bell-api --yes
```

OCI Collector는 배포 직전에 보존한 이미지로 되돌립니다.

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server '
  set -eu
  cd /home/ubuntu/jungle-bell/server
  docker tag jungle-bell-collector:rollback jungle-bell-collector:latest
  docker compose --env-file .env.oci -f docker-compose.oci.yml \
    up -d --no-build --force-recreate
'
```

D1 스키마는 자동 롤백되지 않습니다. 스키마 변경 배포에는 되돌릴 SQL을 함께 준비합니다.

## 장애 확인

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server \
  'docker ps --filter name=jungle-bell-collector'

ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server \
  'docker logs --since 30m jungle-bell-collector'

curl --silent --show-error \
  https://jungle-bell-api.yangsijun5528.workers.dev/v1/status
```

확인 순서는 `컨테이너 실행 여부 -> 원본 API 오류 -> D1 쓰기 오류 -> R2 쓰기 오류 -> API Worker 조회 오류`입니다. D1은 조회 상태의 기준 저장소이며 R2는 원본과 복구 자료 보관소이므로, 두 저장소의 장애를 같은 의미로 처리하지 않습니다.

## 문서 유지 기준

다음 파일의 운영 방식이 바뀌면 같은 변경에서 이 런북도 수정합니다.

- `docker/Dockerfile`, `docker/crontab`
- `docker-compose.oci.yml`, `.env.oci.example`
- `wrangler.api.jsonc`
- D1/R2 자격증명 방식
- 수집 주기와 배포 호스트 경로

HTTP 응답 계약은 `docs/api-reference.md`에서 별도로 관리합니다. 개별 배포 실행 기록과 일회성 문제 해결 메모는 저장소 문서로 누적하지 않습니다.
