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

D1 생성 결과의 `database_id`를 다음 파일에 넣습니다.

- `wrangler.api.jsonc`

R2 버킷은 `wrangler.collector.jsonc`와 `wrangler.api.jsonc`에 동일하게 설정합니다. Collector Worker는 D1을 사용하지 않습니다.

## 3. D1 초기화

```bash
npm run db:reset:remote
```

이 명령은 기존 D1 테이블과 데이터를 모두 삭제합니다. 현재 `schema.sql`만 지원하며 구버전 호환은 제공하지 않습니다. R2와 로컬의 원본 JSON, 수집 commit, 이미지는 영향을 받지 않습니다.

작은 필드 추가는 Wrangler의 `d1 execute --command`로 수동 적용하고 `schema.sql`에도 최종 구조를 반영합니다. 마이그레이션 프레임워크나 구버전 읽기 분기는 만들지 않습니다. 구조를 크게 바꿀 때는 D1을 다시 초기화합니다.

## 4. Collector 배포

```bash
npm run deploy:collector
```

Collector의 Cron Trigger는 `* * * * *`입니다. 세탁 API, pinned 포함 식단 API, 기본 식단 API를 이 순서로 매분 한 번씩 요청합니다. 캐시 우회 쿼리나 `no-cache` 헤더는 보내지 않습니다.

LG ThinQ 모델별 상태값을 알고 있다면 `wrangler.collector.jsonc`의 `vars`에 추가합니다.

```json
"LG_RUN_STATES": "[\"POWER_OFF\",\"WASHING\",\"RINSING\",\"SPINNING\",\"END\"]"
```

기본 목록은 [LG ThinQ Connect SDK](https://github.com/thinq-connect/pythinqconnect)의 장치 프로필 방식을 따릅니다. 집계 API가 장치 프로필을 제공하지 않으므로 모델별 값은 설정으로 확장합니다. 목록에 없는 값은 수집을 실패시키지 않고 `UNKNOWN` 원본값과 경고 로그를 남깁니다.

## 5. API 배포

```bash
npm run deploy:api
```

API Worker도 1분 Cron Trigger를 사용합니다. 이 scheduled 핸들러는 Collector가 R2에 남긴 최신 commit을 D1 조회 모델에 반영합니다. API 배포나 D1 초기화 중에도 Collector Cron Trigger와 R2 백업은 계속 실행되며, API 인덱스는 다음 실행에서 최신 commit을 반영합니다.

## 6. Jungle Bell 앱 연결

API Worker 배포 결과의 HTTPS origin을 GitHub 저장소의 Actions 변수 `JUNGLE_BELL_DATA_API_URL`에 저장합니다. 경로와 마지막 슬래시는 포함하지 않습니다.

```text
https://jungle-bell-api.<account>.workers.dev
```

릴리스 워크플로가 이 값을 Tauri 빌드에 주입합니다. 릴리스 빌드는 변수가 없으면 생활 정보 화면에서 설정 오류를 표시하며 임의의 서버로 대체하지 않습니다.

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
