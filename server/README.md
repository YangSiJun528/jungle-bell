# Jungle Bell server

Jungle Bell 서버는 npm workspace 세 개로 나뉩니다. HTTP 요청은 Cloudflare API
Worker가 처리하고, 수집·알림 같은 주기 작업은 OCI Jobs Runner가 처리합니다. 두 앱은
공통 모델과 저장소 포트만 공유하며 서로의 소스를 import하지 않습니다.

- API Worker: `/api`, 고정 D1/R2 gateway, 대시보드·PWA, 댓글 없는 Markdown 블로그 정적 자산
- Jobs Runner: 세탁·급식 수집, 출석·급식·세탁 알림 계획, housekeeping, Web Push
- D1: 공개 조회 모델, session, pairing, 출석, 개인 설정, 알림 delivery
- R2: 수집 원본·정규화본·이미지·실행 로그

API Worker는 HTTP 요청만 처리합니다. Cron Trigger, Push relay, VAPID private key를
사용하지 않습니다. Jobs Runner의 D1/R2 접근은 API Worker의 인증된
`POST /internal/jobs/d1`과 `POST /internal/jobs/r2`를 거칩니다. 따라서 OCI에는 D1
관리 자격 증명, database 식별자 또는 R2 S3 자격 증명을 배포하지 않습니다. Worker는
환경별 고정 binding에만 접근합니다.

Jobs Runner는 Supercronic이 매분 실행하며 `flock`으로 이전 실행과 겹치지 않게 합니다.
세탁은 매분, 카카오 급식은 기본 5분마다 수집하고 각 lifecycle 단계는 실패를 격리해
이후 housekeeping과 Push도 계속 시도합니다.

## Workspace와 의존성 소유

| Workspace | 경로 | 소유하는 런타임 의존성 | 역할 |
| --- | --- | --- | --- |
| `@jungle-bell/backend-common` | `shared/` | LogTape, `json-canonicalize`, Zod | 순수 요청·응답 모델, 도메인 규칙, 저장소 포트, 공통 persistence·collection |
| `@jungle-bell/api-worker` | `apps/api-worker/` | backend-common, Hono, Hono Zod Validator, LogTape, Zod | Cloudflare HTTP API와 D1/R2 adapter |
| `@jungle-bell/jobs-runner` | `apps/jobs-runner/` | backend-common, LogTape, Commander, Ky, `web-push`, Zod | OCI 수집·lifecycle·알림 작업 |

루트 `@jungle-bell/server` workspace는 TypeScript와 Vitest만 소유하고 앱별 런타임
의존성을 대신 소유하지 않습니다. Wrangler와 Cloudflare Worker type은 API Worker,
Tsup과 Node/Web Push type은 Jobs Runner의 개발 의존성입니다.

의존 방향은 `apps/* → @jungle-bell/backend-common`만 허용합니다. `shared/`는 앱을
참조하지 않고, API Worker와 Jobs Runner도 서로의 소스를 import하지 않습니다. Jobs
Runner가 배포된 Worker의 `/internal/jobs/*`를 호출하는 관계는 소스 의존성이 아니라
서비스 간 HTTP 통신입니다.

## 요청·응답 모델 공유

클라이언트와 API Worker는 Hono RPC를 사용하지 않습니다. 일반 HTTP endpoint를
`fetch`로 호출하고, `@jungle-bell/backend-common/contracts/personal`의 순수 Zod
schema와 추론 type을 함께 사용해 요청과 응답을 검증합니다. Hono는 API Worker 내부의
라우팅과 controller 경계에만 사용합니다.

계약을 변경할 때는 다음 순서를 지킵니다.

1. `shared/contracts/`의 Zod schema와 추론 type을 변경합니다.
2. API controller와 service가 같은 모델을 사용하도록 변경합니다.
3. 프런트엔드 `fetch` client가 요청 직전과 응답 직후 같은 schema로 검증하도록 변경합니다.

이 방식은 HTTP 구현을 특정 서버 framework의 route type에 결합하지 않으면서도 요청과
응답 모델의 단일 출처를 유지합니다.

## 소스 계층

### API Worker

```text
apps/api-worker/src/
├── index.ts                 # Cloudflare Worker 진입점과 route 조립
├── controllers/             # Hono HTTP·인증·검증·응답 경계
├── services/                # API use case와 업무 흐름
├── storage/cloudflare/      # D1·R2 binding과 gateway adapter
└── domain/                  # API 전용 순수 규칙
```

일반 요청은 `controller → service → storage` 방향으로 처리합니다. Service는 공통
`ports/`의 저장소 interface에 의존하고, middleware의 composition root가 Cloudflare
storage 구현을 주입합니다. `/internal/jobs/*` gateway는 Worker 진입점에 등록되는
storage adapter입니다.

### Jobs Runner

```text
apps/jobs-runner/src/
├── jobs.ts                  # Commander CLI 진입점
├── workers/                 # 매분 cycle과 task scheduling·orchestration
├── services/                # 수집·출석 알림·세탁·급식 lifecycle
├── storage/                 # D1/R2 gateway와 DB query 캡슐화
├── clients/                 # 외부 HTTP·급식 media·Web Push
└── configuration/           # 환경 변수와 collector 설정
```

실행 흐름은 `CLI → workers → services → storage`입니다. 외부 네트워크 전송은
`clients/`, 환경 해석은 `configuration/`에 둡니다. Service는 DB query나 Cloudflare
REST 세부사항을 직접 다루지 않고 공통 port 또는 Jobs storage를 사용합니다.

### Backend Common

- `shared/contracts/`: 프런트엔드와 API Worker가 공유하는 순수 Zod 요청·응답 모델
- `shared/domain/`, `shared/renewal/`: 런타임과 저장소에 독립적인 규칙
- `shared/ports/`: 저장소·SQL·collector 경계 interface
- `shared/persistence/`: 두 런타임에서 port 뒤로 재사용하는 D1 repository
- `shared/collection/`: 수집 결과 정규화·투영을 위한 순수 모델과 함수
- `database/schema.sql`: 비어 있는 신규 D1용 current schema

## 로컬 실행과 검증

아래 명령은 `server/`에서 실행합니다.

```bash
npm ci
npm run check
npm run build
```

- `npm run check`: shared, API Worker, Jobs Runner, 테스트의 typecheck와 전체 테스트
- `npm run build`: Jobs Runner Node 번들 생성
- `npm run dev:api`: 루트 웹 자산을 빌드한 뒤 Wrangler 로컬 API Worker 실행
- `npm run jobs:run`: 빌드된 Jobs Runner cycle 한 번 실행
- `npm run db:reset:local`: 로컬 Wrangler D1을 `database/schema.sql`로 초기화

저장소 루트의 `npm run verify:server`는 server check와 Jobs Runner bundle build를 함께
실행합니다.

## 배포 명령

아래 명령도 `server/`에서 실행합니다.

```bash
npm run deploy:api
npm run deploy:api:test
```

각 API 배포 script는 환경별 공개 origin으로 저장소 루트 웹 자산을 먼저 빌드하고,
대시보드와 블로그 자산을 같은 Worker deployment에 포함합니다. Jobs Runner 배포와
장애 대응 절차는 [운영 문서](OPERATIONS.md)를 따릅니다.

## D1 bootstrap

`database/schema.sql`은 과거 schema migration이 아니라 비어 있는 신규 D1 전용
current-schema bootstrap입니다. 실행하면 기존 테이블과 데이터가 삭제됩니다. 기존
`jungle-bell-data`나 사용 중인 D1에는 실행하지 않습니다.

아래 명령은 `server/apps/api-worker/`에서 실행합니다.

```bash
npx wrangler d1 create jungle-bell-v2
# deploy/wrangler.api.jsonc의 영(0) UUID를 신규 D1 ID로 교체한 뒤 새 D1에만 실행
npx wrangler d1 execute DB --remote --file=../../database/schema.sql \
  --config deploy/wrangler.api.jsonc
```

작은 변경은 검토한 비파괴 SQL과 갱신된 `database/schema.sql`을 함께 준비합니다. 파괴적
변경은 새 D1/R2를 만든 뒤 blue/green으로 전환합니다. 구 schema를 읽는 호환 분기는
추가하지 않습니다.

## 관련 문서

- [배포와 장애 대응](OPERATIONS.md)
- [환경과 바인딩](docs/environment-reference.md)
- [HTTP API](docs/api-reference.md)
