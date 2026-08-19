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
- 네 secret 파일의 절대 경로
- `CLOUDFLARE_TUNNEL_TOKEN`
- `LAUNDRY_SOURCE_URL`
- `VAPID_SUBJECT`

`CLOUDFLARE_TUNNEL_TOKEN`, 데이터베이스 비밀번호, pairing secret, VAPID private key는
저장소 밖에서 관리합니다.

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

저장소 내용을 배포 디렉터리에 동기화한 뒤 Compose 설정을 검증합니다.

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

## 배포 확인

모든 외부 검증은 공식 origin에서 실행합니다.

```bash
curl --fail --silent https://jungle-bell.sijun-yang.com/ >/dev/null
curl --fail --silent https://jungle-bell.sijun-yang.com/actuator/health/readiness
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
