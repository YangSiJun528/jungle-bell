# Cloudflare에 배포하기

이 문서는 D1, R2, Collector Worker, API Worker를 처음 배포하는 절차입니다.

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

```bash
npx wrangler d1 create jungle-bell-data
npx wrangler r2 bucket create jungle-bell-data
```

D1 생성 결과의 `database_id`를 다음 두 파일의 `REPLACE_WITH_D1_DATABASE_ID` 자리에 넣습니다.

- `workers/collector-worker/wrangler.jsonc`
- `workers/api-worker/wrangler.jsonc`

두 Worker는 반드시 같은 D1과 R2 바인딩을 사용해야 합니다.

## 3. D1 마이그레이션

```bash
npm run d1:migrate:remote
```

## 4. Collector 배포

```bash
npm run deploy:collector
```

Collector의 Cron Trigger는 `* * * * *`입니다. 세탁 API, pinned 포함 식단 API, 기본 식단 API를 이 순서로 매분 한 번씩 요청합니다. 캐시 우회 쿼리나 `no-cache` 헤더는 보내지 않습니다.

LG ThinQ 모델별 상태값을 알고 있다면 `workers/collector-worker/wrangler.jsonc`의 `vars`에 추가합니다.

```json
"LG_RUN_STATES": "[\"POWER_OFF\",\"WASHING\",\"RINSING\",\"SPINNING\",\"END\"]"
```

기본 목록은 [LG ThinQ Connect SDK](https://github.com/thinq-connect/pythinqconnect)의 장치 프로필 방식을 따릅니다. 집계 API가 장치 프로필을 제공하지 않으므로 모델별 값은 설정으로 확장합니다. 목록에 없는 값은 수집을 실패시키지 않고 `UNKNOWN` 원본값과 경고 로그를 남깁니다.

## 5. API 배포

```bash
npm run deploy:api
```

API 배포는 Collector 배포와 독립적입니다. API Worker를 다시 배포하는 동안에도 Collector Cron Trigger는 계속 실행됩니다.

## 6. Jungle Bell 앱 연결

API Worker 배포 결과의 HTTPS origin을 GitHub 저장소의 Actions 변수 `JUNGLE_BELL_DATA_API_URL`에 저장합니다. 경로와 마지막 슬래시는 포함하지 않습니다.

```text
https://jungle-bell-api.<account>.workers.dev
```

릴리스 워크플로가 이 값을 Tauri 빌드에 주입합니다. 릴리스 빌드는 변수가 없으면 생활 정보 화면에서 설정 오류를 표시하며 임의의 서버로 대체하지 않습니다. 로컬 디버그 빌드는 기본적으로 `http://127.0.0.1:8787`을 사용합니다.

직접 릴리스 빌드를 만들 때는 같은 변수를 지정합니다.

```bash
cd ..
JUNGLE_BELL_DATA_API_URL=https://jungle-bell-api.<account>.workers.dev cargo tauri build
```

## 7. 상태 확인

배포된 각 Worker에서 다음 경로를 확인합니다.

```text
Collector: GET /healthz
API:       GET /healthz
```

API의 `/healthz`는 원본 3개 중 하나라도 3분 넘게 정상 수집되지 않았거나 연속 3회 실패하면 `503 DEGRADED`를 반환합니다.
