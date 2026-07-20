# Cloudflare 저장소와 API Worker 배포하기

이 가이드는 D1, R2, 조회 전용 API Worker를 배포하는 절차입니다. 수집 실행은 OCI Collector가 담당하며 Cloudflare Collector Worker와 Cron Trigger는 사용하지 않습니다.

## 사전 조건

- Node.js 22 이상
- Cloudflare 계정과 Wrangler 로그인
- 저장소의 `server` 디렉터리

## 1. 의존성 설치

```bash
cd server
npm ci
```

## 2. 저장소 생성

새 환경에서만 실행합니다.

```bash
npx wrangler d1 create jungle-bell-data
npx wrangler r2 bucket create jungle-bell-data
```

D1 생성 결과의 `database_id`를 `wrangler.api.jsonc`와 `.env.oci`에 동일하게 설정합니다.

## 3. D1 초기화

```bash
npm run db:reset:remote
```

이 명령은 기존 D1 테이블과 데이터를 모두 삭제합니다. 이미 운영 중인 데이터베이스에서는 초기화 목적으로 다시 실행하지 않습니다.

## 4. API Worker 배포

```bash
npm run deploy:api
```

API Worker에는 scheduled handler와 Cron Trigger가 없습니다. HTTP 요청에서 D1과 R2를 읽는 역할만 담당합니다.

## 5. OCI 쓰기 자격증명 생성

Cloudflare API Token에는 대상 계정의 `D1 Write` 권한만 부여합니다. OCI Collector는 이 토큰으로 D1 `/query` REST API를 호출합니다.

R2에서는 `jungle-bell-data` 버킷에 한정된 Object Read & Write API Token을 만들고 Access Key ID와 Secret Access Key를 발급합니다. 자격증명 원문은 저장소나 `.env`에 기록하지 않습니다.

OCI 호스트에 자격증명을 설치하는 절차는 [OCI Collector 배포](guide-deploy-oci-collector.md)를 따릅니다.

## 6. Jungle Bell 앱 연결

API Worker 배포 결과의 HTTPS origin을 GitHub Actions 변수 `JUNGLE_BELL_DATA_API_URL`에 저장합니다. 경로와 마지막 슬래시는 포함하지 않습니다.

```text
https://jungle-bell-api.<account>.workers.dev
```

## 7. 상태 확인

배포된 API Worker의 다음 경로를 확인합니다.

```text
GET /healthz
GET /v1/laundry/latest
GET /v1/meals
```

`/healthz`는 세탁실이 3분, 급식 소스가 12분 넘게 정상 수집되지 않았거나 연속 3회 실패하면 `503 DEGRADED`를 반환합니다.
