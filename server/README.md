# Jungle Bell server

Jungle Bell의 HTTP 서버와 주기 작업을 한 패키지에서 관리합니다. 배포 런타임은
요청 처리와 장기 작업을 분리합니다.

- App Worker: `/api`, 고정 D1/R2 gateway, 대시보드·PWA, 댓글 없는 Markdown 블로그 정적 자산
- OCI Jobs: 세탁·급식 수집, 출석·급식·세탁 알림 계획, housekeeping, Web Push
- D1: 공개 조회 모델, session, pairing, 출석, 개인 설정, 알림 delivery
- R2: 수집 원본·정규화본·이미지·실행 로그

App Worker는 HTTP 요청만 처리합니다. Cron Trigger, Push relay, VAPID private key를
사용하지 않습니다. OCI Jobs의 D1 접근은 App Worker의 인증된
`POST /internal/jobs/d1`과 `/internal/jobs/r2`를 거치므로 OCI에 D1 관리 자격 증명,
database 식별자 또는 R2 S3 자격 증명을 배포하지 않습니다. Worker는 환경별 고정
binding에만 접근합니다.

OCI Jobs는 Supercronic이 매분 실행하며 `flock`으로 이전 실행과 겹치지 않게 합니다.
세탁은 매분, 카카오 급식은 기본 5분마다 수집하고 각 lifecycle 단계는 실패를 격리해
이후 housekeeping과 Push도 계속 시도합니다.

## 소스 구조

- `src/http/`: 공개·desktop·mobile·pairing·알림·Push HTTP 경계
- `src/application/`, `src/domain/`: 저장소와 전송 방식에 독립적인 규칙
- `src/repositories/`: 기능별 D1 repository
- `src/workers/api.ts`: HTTP-only App Worker 조립 진입점
- `src/workers/d1-gateway.ts`: OCI 전용 고정 `DB` binding gateway
- `src/workers/r2-gateway.ts`: OCI 전용 고정 `DATA_BUCKET` binding gateway
- `src/node/jobs.ts`: OCI Jobs 조립 진입점
- `src/node/d1-gateway-database.ts`: gateway를 D1 repository에 연결하는 Node adapter
- `src/collector/`, `src/storage/`: 수집·정규화·D1/R2 투영

## 로컬 검증

```bash
npm ci
npm run check
npm run build
```

`npm run build`는 OCI Jobs Node 번들을 만듭니다. App Worker 배포 스크립트는 환경별
공개 origin으로 루트 웹 빌드를 먼저 실행해 대시보드와 블로그 자산을 같은 Worker
deployment에 포함합니다. 저장소 루트의 `npm run verify:server`는 server check와
Jobs 번들 build를 모두 실행합니다.

## D1 bootstrap

`schema.sql`은 과거 schema migration이 아니라 비어 있는 신규 D1 전용 current-schema
bootstrap입니다. 실행하면 기존 테이블과 데이터가 삭제됩니다. 기존
`jungle-bell-data`나 사용 중인 D1에는 실행하지 않습니다.

```bash
npx wrangler d1 create jungle-bell-v2
# wrangler.api.jsonc의 영(0) UUID를 신규 D1 ID로 교체한 뒤 새 D1에만 실행
npx wrangler d1 execute DB --remote --file=schema.sql --config wrangler.api.jsonc
```

작은 변경은 검토한 비파괴 SQL과 갱신된 `schema.sql`을 함께 준비합니다. 파괴적
변경은 새 D1/R2를 만든 뒤 blue/green으로 전환합니다. 구 schema를 읽는 호환 분기는
추가하지 않습니다.

## 운영 문서

- [배포와 장애 대응](OPERATIONS.md)
- [환경과 바인딩](docs/environment-reference.md)
- [HTTP API](docs/api-reference.md)
