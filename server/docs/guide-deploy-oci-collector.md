# OCI에 Collector 배포하기

이 가이드는 `oci-server`의 기존 Docker 환경에 Collector를 배포하는 절차입니다. VM에는 public IP가 없고 Tailscale SSH와 outbound NAT만 사용합니다. Collector는 수신 포트를 열지 않으며 기존 n8n과 BOINC 컨테이너를 변경하지 않습니다.

## 사전 조건

- Tailscale에 연결된 관리 장치
- `ubuntu@oci-server` SSH 접근
- OCI 호스트의 Docker
- Cloudflare 계정 ID와 D1 데이터베이스 ID
- D1 Write API Token
- 대상 R2 버킷 전용 Access Key ID와 Secret Access Key

## 1. 호스트 접속

```bash
ssh -i ~/.ssh/oci_a1_flex ubuntu@oci-server
```

배포 디렉터리에 저장소를 배치한 뒤 `server` 디렉터리로 이동합니다.

## 2. Secret 파일 생성

```bash
install -d -m 700 ~/.config/jungle-bell-collector
read -rsp "Cloudflare D1 API token: " VALUE; echo
printf '%s\n' "$VALUE" > ~/.config/jungle-bell-collector/cloudflare-d1-api-token
unset VALUE
read -rsp "R2 access key ID: " VALUE; echo
printf '%s\n' "$VALUE" > ~/.config/jungle-bell-collector/r2-access-key-id
unset VALUE
read -rsp "R2 secret access key: " VALUE; echo
printf '%s\n' "$VALUE" > ~/.config/jungle-bell-collector/r2-secret-access-key
unset VALUE
chmod 600 ~/.config/jungle-bell-collector/*
```

Secret 파일은 컨테이너의 `/run/secrets`에 읽기 전용으로 마운트됩니다. 값 자체는 Docker 환경변수나 `docker inspect` 결과에 노출되지 않습니다.

## 3. 배포 환경 설정

```bash
cp .env.oci.example .env.oci
chmod 600 .env.oci
```

`.env.oci`의 `CLOUDFLARE_ACCOUNT_ID`를 실제 계정 ID로 바꿉니다. D1 데이터베이스 ID가 `wrangler.api.jsonc`와 같은지도 확인합니다. R2 jurisdiction별 endpoint를 사용하는 경우에만 `R2_ENDPOINT`를 설정합니다.

## 4. 설정 검사와 배포

```bash
docker compose --env-file .env.oci -f docker-compose.oci.yml config --quiet
docker compose --env-file .env.oci -f docker-compose.oci.yml build
docker compose --env-file .env.oci -f docker-compose.oci.yml up -d
```

이미지는 OCI A1 Flex의 `arm64`에서 직접 빌드됩니다. Supercronic은 매분 Collector를 실행하고 `flock`이 이전 실행과의 중첩을 막습니다. 세탁실을 먼저 수집하고 UTC 분이 5의 배수일 때 카카오 pinned 포함 API와 기본 API를 차례로 수집합니다.

## 5. 검증

```bash
docker ps --filter name=jungle-bell-collector
docker logs --since 10m jungle-bell-collector
docker exec jungle-bell-collector supercronic -test /etc/jungle-bell/crontab
```

로그에서 다음을 확인합니다.

- 매분 `laundry` 결과가 존재함
- 5분마다 `meals-include-pinned`, `meals-default`가 순서대로 존재함
- D1 요청에 `401`, `403`, `429`가 없음
- R2 요청에 `AccessDenied`, `NoSuchBucket`이 없음

그 다음 API Worker의 `/healthz`, `/v1/laundry/latest`, `/v1/meals`를 확인합니다.

## 6. 전환

OCI 수집 결과가 D1/R2에서 확인되면 새 API Worker를 배포해 기존 API Cron Trigger를 제거하고, 기존 Cloudflare `jungle-bell-collector` Worker를 삭제합니다. API Worker, D1, R2는 유지합니다.

## 운영 명령

```bash
docker logs -f jungle-bell-collector
docker restart jungle-bell-collector
docker compose --env-file .env.oci -f docker-compose.oci.yml up -d --build
docker compose --env-file .env.oci -f docker-compose.oci.yml down
```

`down`은 Cloudflare에 저장된 데이터에 영향을 주지 않습니다.
