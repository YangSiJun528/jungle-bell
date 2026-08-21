# OCI 운영 서버 배포

이 문서는 Mac에서 Tailscale SSH로 OCI 운영 서버에 접속해 Jungle Bell을 배포하고,
PostgreSQL 데이터를 이관한 뒤 Cloudflare named Tunnel로 공식 origin을 연결하는
절차를 설명합니다.

공식 origin은 `https://jungle-bell.sijun-yang.com`입니다. 비밀 값, OCI OCID, 현재 공인
IP는 이 문서에 기록하지 않습니다.

## 전제 조건

- 저장소 루트에서 명령을 실행합니다.
- Mac과 OCI의 Tailscale 연결이 정상이고, MagicDNS FQDN
  `oci-server.tail3cbec1.ts.net`을 해석할 수 있어야 합니다.
- 서버 접근이 안 되면 [OCI 운영 서버 접근 복구](guide_oci_access_recovery.md)를 먼저
  수행합니다.
- 로컬 `server/deploy/.env.production`과 다섯 개의 secret 파일은 Git에 포함하지 않습니다.
- 기존 배포는 롤백이 끝날 때까지 삭제하지 않습니다.
- [서버 운영 절차의 버전과 배포 기록](../OPERATIONS.md#버전과-배포-기록)에 따라 버전
  계약 테스트를 통과해야 합니다. 공식 릴리스는 깨끗한 working tree에서 빌드합니다.

이 문서의 서버 경로는 다음과 같습니다.

| 용도 | 경로 |
| --- | --- |
| 새 운영 배포 | `/home/ubuntu/jungle-bell-production` |
| 운영 secret | `/home/ubuntu/.config/jungle-bell` |
| DB 백업 | `/home/ubuntu/backups/jungle-bell` |
| 이전 배포 | `/home/ubuntu/jungle-bell-spring-v2-test` |

## 1. 소스와 환경 파일 전송

로컬 `server/deploy/.env.production`이 운영 설정의 원본입니다. 최초 배포뿐 아니라 모든
배포에서 소스와 함께 전송합니다. 원격 서버에 남아 있는 환경 파일을 다음 배포의 입력으로
재사용하거나 직접 수정하지 않습니다.

로컬 저장소 루트에서 환경 파일의 필수값과 Compose 설정을 먼저 검증합니다.

```bash
test -s server/deploy/.env.production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  config --quiet
```

검증에 성공하면 새 운영 디렉터리를 만들고 소스를 동기화합니다.

```bash
ssh ubuntu@oci-server.tail3cbec1.ts.net 'install -d -m 0700 /home/ubuntu/jungle-bell-production'

rsync -az \
  --exclude .git/ \
  --exclude node_modules/ \
  --exclude frontend/node_modules/ \
  --exclude server/.gradle/ \
  --exclude server/build/ \
  --exclude desktop/target/ \
  --exclude target/ \
  --exclude .DS_Store \
  --exclude server/deploy/.env.production \
  -e 'ssh -i ~/.ssh/oci_a1_flex -o IdentitiesOnly=yes' \
  ./ ubuntu@oci-server.tail3cbec1.ts.net:/home/ubuntu/jungle-bell-production/

scp -i ~/.ssh/oci_a1_flex \
  server/deploy/.env.production \
  ubuntu@oci-server.tail3cbec1.ts.net:/home/ubuntu/jungle-bell-production/server/deploy/.env.production.upload
```

서버에서 업로드 파일의 로컬 secret 경로를 OCI 경로로 바꾼 뒤 권한 `0600`으로 원자적으로
교체합니다. 변환이나 설치가 실패하면 기존 운영 환경 파일을 유지하고 배포를 중단합니다.

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server.tail3cbec1.ts.net '
  set -eu
  upload=/home/ubuntu/jungle-bell-production/server/deploy/.env.production.upload
  destination=/home/ubuntu/jungle-bell-production/server/deploy/.env.production
  sed -i \
    "s#/Users/sijun-yang/.config/jungle-bell#/home/ubuntu/.config/jungle-bell#g" \
    "$upload"
  chmod 0600 "$upload"
  mv -f "$upload" "$destination"
'
```

## 2. 운영 secret 준비

새로 발급한 값을 배치하거나, 최초 전환에서는 이전 운영 secret을 복사합니다.

```bash
install -d -m 0700 /home/ubuntu/.config/jungle-bell

for name in database-password pairing-secret vapid-public-key vapid-private-key; do
  install -m 0600 \
    "/home/ubuntu/.config/jungle-bell-spring-v2-test/$name" \
    "/home/ubuntu/.config/jungle-bell/$name"
done

if [ ! -e /home/ubuntu/.config/jungle-bell/usage-hash-secret ]; then
  openssl rand -hex 32 > /home/ubuntu/.config/jungle-bell/usage-hash-secret
  chmod 0600 /home/ubuntu/.config/jungle-bell/usage-hash-secret
fi
```

상위 디렉터리는 계속 `0700`으로 유지합니다. secret 내용을 로그나 터미널 출력으로
검증하지 않습니다. 컨테이너 읽기 권한은 이미지를 빌드한 뒤 설정합니다.

## 3. 설정 검증과 이미지 빌드

Compose 설정을 먼저 검증합니다.

```bash
cd /home/ubuntu/jungle-bell-production

docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  config --quiet
```

API와 Worker를 동시에 빌드하지 않고 순차적으로 빌드합니다. 각 빌드에서 프런트엔드
타입 검사와 전체 Gradle 검사가 실행됩니다.

```bash
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  build api

docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  build worker
```

API와 Worker는 non-root 사용자로 실행됩니다. Compose의 파일 기반 secret은 호스트
파일 권한을 유지하므로, 빌드된 이미지의 런타임 GID에만 읽기 권한을 줍니다.

```bash
api_gid=$(docker run --rm --entrypoint id jungle-bell-api:production -g)
worker_gid=$(docker run --rm --entrypoint id jungle-bell-worker:production -g)
test "$api_gid" = "$worker_gid"

for name in database-password pairing-secret usage-hash-secret vapid-public-key vapid-private-key; do
  sudo chgrp "$api_gid" "/home/ubuntu/.config/jungle-bell/$name"
  chmod 0640 "/home/ubuntu/.config/jungle-bell/$name"
done
```

빌드가 실패하면 기존 서비스를 중지하지 않습니다.

## 4. PostgreSQL 백업과 최초 이관

새 PostgreSQL은 기존 PostgreSQL과 호스트 port를 공유하지 않으므로 먼저 준비할 수
있습니다.

```bash
cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d --wait --wait-timeout 120 postgres
```

이전 API, Worker, Quick Tunnel을 중지한 뒤 실제 백업 시점의 건수를 기록합니다.

```bash
cd /home/ubuntu/jungle-bell-spring-v2-test
docker compose \
  --profile quick-tunnel \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  stop worker quick-tunnel api

docker exec jungle-bell-postgres-v2-test psql -U jungle_bell -d jungle_bell -c '
SELECT
  (SELECT count(*) FROM meal_post) AS meal_posts,
  (SELECT count(*) FROM meal_image) AS meal_images,
  (SELECT count(*) FROM minute_observation) AS minute_observations;'
```

백업 파일을 만들고 목차를 읽어 손상 여부를 확인합니다.

```bash
install -d -m 0700 /home/ubuntu/backups/jungle-bell
backup_path="/home/ubuntu/backups/jungle-bell/pre-production-$(date +%Y%m%d-%H%M%S).dump"

docker exec jungle-bell-postgres-v2-test \
  pg_dump -U jungle_bell -d jungle_bell -Fc > "$backup_path"
chmod 0600 "$backup_path"
docker exec -i jungle-bell-postgres-v2-test pg_restore -l < "$backup_path" >/dev/null
```

빈 새 DB에 복원합니다. 전환 재시도라서 새 DB에 이전 복원 결과가 남아 있다면, 아직
서비스하지 않은 `jungle-bell-postgres`만 대상으로 DB를 다시 만든 뒤 복원합니다.

```bash
docker exec jungle-bell-postgres \
  psql -U jungle_bell -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS jungle_bell WITH (FORCE);'
docker exec jungle-bell-postgres \
  createdb -U jungle_bell -O jungle_bell jungle_bell

docker exec -i jungle-bell-postgres \
  pg_restore --exit-on-error \
  -U jungle_bell -d jungle_bell --no-owner --no-privileges < "$backup_path"
```

새 DB에서 같은 세 테이블의 건수를 조회해 백업 직전 결과와 일치하는지 확인합니다.
일치하지 않으면 전환하지 않습니다.

## 5. API 전환

이전 PostgreSQL은 계속 실행한 상태에서 새 API를 먼저 검증합니다.

```bash
cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d --wait --wait-timeout 180 api

curl --fail --silent http://127.0.0.1:8080/actuator/health/readiness
curl --fail --silent http://127.0.0.1:8080/api/health
curl --fail --silent http://127.0.0.1:8080/api/public/status
```

readiness가 통과하면 이전 PostgreSQL을 중지하고 새 Worker를 시작합니다.

```bash
cd /home/ubuntu/jungle-bell-spring-v2-test
docker compose \
  --profile quick-tunnel \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  stop postgres

cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d worker
```

## 6. Cloudflare named Tunnel 연결

Cloudflare 대시보드에서 `Networking` → `Tunnels`로 이동해 remotely-managed Tunnel
`jungle-bell-production`을 선택합니다. `Add a replica` → `Docker`에 표시되는 명령에서
`--token` 뒤의 `eyJ...` 값만 복사해 로컬과 서버의 추적되지 않는
`.env.production`에 저장합니다.

Tunnel의 `Routes` 탭에서 `Add route` → `Published application`을 선택하고 다음 public
hostname을 설정합니다.

| 항목 | 값 |
| --- | --- |
| Public hostname | `jungle-bell.sijun-yang.com` |
| Service type | `HTTP` |
| Service URL | `http://api:8080` |

`Provided Tunnel token is not valid`가 나오면 기존 토큰을 재사용하지 말고 `Add a
replica`에서 현재 토큰을 다시 가져옵니다. 토큰 자체는 터미널 출력, 문서, Git에 남기지
않습니다.

```bash
cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  up -d --force-recreate tunnel

docker logs --since 5m jungle-bell-tunnel
```

로그에서 네 개의 연결이 등록되고 재시작이 반복되지 않는지 확인합니다. 대시보드에서
public hostname을 추가하면 해당 Tunnel을 가리키는 DNS 레코드도 함께 생성됩니다.

Cloudflare 참고 문서:

- <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/>
- <https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/>

## 7. 외부 검증

DNS와 공식 origin을 확인합니다.

```bash
dig +short @1.1.1.1 jungle-bell.sijun-yang.com

curl --fail --silent https://jungle-bell.sijun-yang.com/ >/dev/null
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/health/readiness
curl --fail --silent https://jungle-bell.sijun-yang.com/api/health
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/status
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/laundry
curl --fail --silent https://jungle-bell.sijun-yang.com/api/public/meals
server/tools/smoke-api.sh https://jungle-bell.sijun-yang.com
```

스모크 스크립트는 성공·실패 종료 시 인증된 identity 삭제 API로 임시 계정 정리를
시도합니다. 출력에 `testAccount=deleted`가 있어야 외부 검증을 통과한 것입니다.

서버에서도 상태와 최근 오류를 확인합니다.

```bash
cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  ps
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  logs --since 10m api worker tunnel postgres
```

검증을 마치면 버전, Git SHA, 두 이미지 digest, 배포 시각, working tree 상태를 한 배포
기록에 남깁니다.

```bash
git status --short
git rev-parse HEAD
docker image inspect --format '{{.Id}}' jungle-bell-api:production
docker image inspect --format '{{.Id}}' jungle-bell-worker:production
date '+%Y-%m-%dT%H:%M:%S%:z'
```

필드 이름과 `dirty` 판정은
[서버 운영 절차](../OPERATIONS.md#버전과-배포-기록)를 따릅니다. 명령 결과가 남아 있지
않거나 공식 배포에서 `dirty=false`를 입증할 수 없으면 배포 기록이 완료된 것이 아닙니다.

## 롤백

새 API, Worker 또는 Tunnel 검증이 실패하면 새 애플리케이션 컨테이너를 중지하고 기존
스택을 다시 시작합니다. 새 DB volume과 dump는 원인 확인을 위해 보존합니다.

```bash
cd /home/ubuntu/jungle-bell-production
docker compose \
  --env-file server/deploy/.env.production \
  -f server/deploy/compose.production.yml \
  stop tunnel worker api

cd /home/ubuntu/jungle-bell-spring-v2-test
docker compose \
  --profile quick-tunnel \
  --env-file server/deploy/.env.v2-test \
  -f server/deploy/compose.v2-test.yml \
  start postgres api worker quick-tunnel
```

기존 PostgreSQL과 API가 healthy인지 확인한 뒤에만 장애가 끝난 것으로 판단합니다.
