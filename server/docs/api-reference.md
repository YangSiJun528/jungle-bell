# HTTP API 레퍼런스

API Worker는 공개 데이터와 설치 단위 개인 데이터를 같은 origin에서 제공합니다.
공개 GET은 캐시할 수 있지만 데스크톱·모바일·페어링·알림·Push 응답은
`no-store`입니다. LMS credential과 LMS identity는 어떤 endpoint도 입력으로
받거나 저장하지 않습니다.

## 공통 캐시 정책

| 응답 종류 | `Cache-Control` |
| --- | --- |
| 최신 상태, 이벤트, 식단 | `public, max-age=15, s-maxage=30, stale-while-revalidate=120` |
| 분 단위 이력, SHA 버전, 이미지 | `public, max-age=31536000, immutable` |
| 오류, health check, `/internal/*` | `no-store` |

공개 GET 응답은 Cloudflare Cache API에도 저장됩니다. JSON 응답과 이미지는 `ETag` 조건부 요청을 지원합니다.

## OCI Jobs gateway

### `POST /internal/jobs/d1`

OCI Jobs 전용 endpoint입니다. App Worker의 공개 origin에 있지만 브라우저·PC·PWA용
API가 아니며 `Authorization: Bearer <JOBS_D1_GATEWAY_SECRET>` 인증이 필요합니다.
App Worker의 고정 `DB` binding만 사용하므로 요청 본문으로 database 이름이나 ID를
선택할 수 없습니다.

단일 요청은 다음 형태입니다.

```json
{
  "sql": "SELECT value FROM example WHERE id = ?",
  "params": ["example-id"]
}
```

D1 batch는 `{ "batch": [{ "sql": "...", "params": [] }] }` 형태입니다.
SQL은 `SELECT`, `INSERT`, `UPDATE`, `DELETE` 또는 이들 문장으로 이어지는 `WITH`
단일 statement만 허용하며 세미콜론과 다중 statement는 거부합니다.

| 제한 | 값 |
| --- | --- |
| Request body | 최대 1 MiB |
| Batch statement | 최대 50개 |
| SQL | statement당 최대 64 KiB |
| Parameter | statement당 최대 100개 |
| 문자열 parameter | 항목당 최대 256 KiB |

응답은 `{ "results": [...] }` 형태의 D1 실행 결과이며 항상 `no-store`입니다. 주요
오류는 secret 미설정 `503 D1_GATEWAY_NOT_CONFIGURED`, 인증 실패
`401 AUTHENTICATION_REQUIRED`, 잘못된 media type `415 UNSUPPORTED_MEDIA_TYPE`, 크기
초과 `413 PAYLOAD_TOO_LARGE`, 허용되지 않은 query `400 INVALID_D1_REQUEST`, D1 실행
실패 `422 D1_EXECUTION_FAILED`입니다. OCI adapter는 network 오류, `429`, `5xx`만
설정된 횟수만큼 재시도합니다.

### `GET|HEAD|PUT /internal/jobs/r2?key=<object-key>`

OCI Jobs가 App Worker의 고정 `DATA_BUCKET` binding을 읽고 쓰는 endpoint입니다.
D1 gateway와 같은 `Authorization: Bearer <JOBS_D1_GATEWAY_SECRET>`을 요구하며
인증하기 전에는 key 유효성이나 객체 존재 여부를 확인하지 않습니다. 요청으로 bucket
이름이나 account를 선택할 수 없습니다.

허용 key는 collector가 사용하는 `raw/`, `latest/raw/`, `versions/laundry/`,
`versions/meals/`, `media-map/`, `assets/`, `collector/commits/`,
`collector/latest/`, `collector/state/`, `logs/jobs-runs/` prefix와
`latest/laundry.json`, `latest/meals.json`으로 제한합니다. `..`, 빈 path segment,
제어 문자와 allowlist 밖 key는 거부합니다.

`PUT`은 JSON 또는 allowlist된 raster 이미지(AVIF, GIF, JPEG, PNG, WebP) raw body만
받습니다. `Content-Length`가 필요하고 최대 크기는 16 MiB입니다. `GET`은 body를
streaming하며 `HEAD`는 metadata만 반환합니다. 모든 응답은 `no-store`이고 CORS를
제공하지 않습니다.

## 상태 엔드포인트

### `GET /api/health`

Collector 신선도를 확인합니다. 정상은 `200 OK`, 수집 지연 또는 연속 실패는 `503 DEGRADED`입니다.

### `GET /api/public/status`

세 원본의 마지막 시도, 마지막 성공, 원본 SHA, 연속 실패 횟수를 반환합니다.

## 세탁기 엔드포인트

### `GET /api/public/laundry/head`

현재 세탁 원본 버전 포인터와 마지막 정상 수집 시각을 반환합니다.

### `GET /api/public/laundry`

마지막 LG 관측값과 현재 시점의 명시적 추정값을 함께 반환합니다. `projection.status` 값은 다음과 같습니다.

| 값 | 의미 |
| --- | --- |
| `ESTIMATED_RUNNING` | 마지막 관측 잔여시간에서 경과시간을 뺀 추정값 |
| `AWAITING_COMPLETION_CONFIRMATION` | 추정 잔여시간은 0이지만 LG의 `END`를 아직 관측하지 못함 |
| `CONFIRMED_COMPLETED` | LG 응답에서 `END`를 직접 관측함 |
| `PAUSED`, `ERROR`, `IDLE`, `UNKNOWN` | 마지막 관측 상태 |

`quality.sourceFreshness`는 다음과 같이 해석합니다.

| 값 | 의미 |
| --- | --- |
| `REFRESH_OBSERVED` | 최근 1분 안에 원본 SHA가 변경됨 |
| `WITHIN_REFRESH_WINDOW` | 활성 기기이며 통상적인 5분 갱신 범위 안임 |
| `UNVERIFIABLE_STABLE` | 5분 경계 부근이거나 비활성 상태라 원본 내부 갱신 여부를 확인할 수 없음 |
| `REFRESH_OVERDUE` | 활성 기기인데 6분 넘게 원본 변화가 없음 |
| `COLLECTION_GAP` | 수집 실패 또는 2분 넘는 수집 지연이 발생함 |

완료는 추정하지 않습니다. 잔여시간이 0이 되어도 `END`가 올 때까지 `AWAITING_COMPLETION_CONFIRMATION`입니다.

### `GET /api/public/laundry/at?time=<RFC3339>`

주어진 시각을 UTC 분으로 내림한 뒤 정규 분 URL로 `308` 리다이렉트합니다.

### `GET /api/public/laundry/minutes/:YYYYMMDDTHHmmZ`

해당 분의 불변 관측을 반환합니다. 수집이 실패한 분에도 직전 정상 버전이 있으면 그 값을 `COLLECTION_GAP` 품질로 반환합니다.

응답의 `data.final: true`는 이 분의 API 결과가 더 이상 바뀌지 않는다는 뜻입니다. 세탁 완료를 뜻하지 않습니다.

### `GET /api/public/laundry/versions/:sha`

해당 원본 JSON SHA가 처음 나타났을 때의 정규화본을 반환합니다. 같은 SHA가 나중에 다시 나타난 정확한 발생 시점은 분 단위 엔드포인트로 조회합니다.

### `GET /api/public/laundry/events?since=<RFC3339>&limit=100`

최신 세탁 이벤트를 반환합니다. `limit` 범위는 1부터 500입니다.

ETA 변화량은 다음 식으로 계산합니다.

```text
etaDeltaMinutes = currentRemaining - previousRemaining + elapsedMinutes
```

- `etaDeltaMinutes > 1`: `ETA_EXTENDED`
- `etaDeltaMinutes < -1`: `ETA_REDUCED`
- 나머지: `COUNTDOWN_NORMAL`

각 이벤트의 `changeWindow`는 변화가 발생한 정확한 초가 아니라 `(previousObservedAt, observedAt]` 범위를 나타냅니다.

LG 프로필에 없는 enum은 다음 형태로 그대로 노출됩니다.

```json
{
  "code": "UNKNOWN",
  "raw": "MODEL_SPECIFIC_STATE",
  "known": false
}
```

API는 표시 언어에 종속된 라벨을 반환하지 않습니다. 클라이언트는 `state.code`, `operationalStatus`, `projection.status`, 이벤트의 `type`을 표시 언어에 맞게 변환합니다.

## 식단 엔드포인트

### `GET /api/public/meals`

pinned 주간 식단표, 현재 중식·석식 게시물, 기타 게시물을 구분해 반환합니다. 각 게시물의 `contentSha`는 제목, 본문, 이미지 콘텐츠 SHA 목록으로 계산하며 게시 시각이나 CDN URL 변경은 포함하지 않습니다.

`data.currentWeeklyMenu`는 현재 화면에 표시할 주간 식단표의 판정 결과입니다. `targetWeekKey`는 해당 주의 월요일이며, 일요일에는 다음 날 월요일을 사용합니다. pinned 게시물 제목의 `N월 N주차`를 식단 제공자의 첫 월요일 기준으로 변환한 주차가 `targetWeekKey`와 일치할 때만 `status`가 `AVAILABLE`이고 `post`가 존재합니다. 아직 이전 주 pinned 게시물만 있으면 `AWAITING_UPDATE`와 `post: null`을 반환합니다. 과거 버전은 `data.weeklyMenus`에 계속 보존됩니다.

`data.recentMenus`에는 카카오 최신 목록에서 제거된 게시물도 포함한 최근 식단 최대 30개가 들어갑니다. 각 이미지에는 원본 카카오 URL, 콘텐츠 SHA, 보관 객체 키, API 이미지 URL이 포함됩니다.

### `GET /api/public/meals/history?before=<RFC3339>&limit=30`

D1에 누적된 과거 식단을 최신순으로 반환합니다. `limit` 범위는 1부터 100이며 `nextBefore`가 있으면 다음 요청의 `before`로 사용합니다. 카카오에서 게시물이 제거되어도 수집된 본문과 이미지 메타데이터는 이 엔드포인트에서 계속 조회할 수 있습니다.

### `GET /api/public/assets/:sha.:extension`

R2에 보관된 식단 이미지를 반환합니다. 콘텐츠 SHA 주소이므로 1년 immutable 캐시를 사용합니다.

## 설치·개인 데이터 엔드포인트

| Method와 path | 인증 | 용도 |
| --- | --- | --- |
| `POST /api/desktop/installations` | 없음, rate limit | 새 PC 설치 자격 증명 발급 |
| `POST /api/desktop/installations/rotate` | Desktop bearer | 만료 전 자격 증명 원자적 교체 |
| `POST /api/desktop/heartbeat` | Desktop bearer | `lmsSessionState`, `appVersion` heartbeat 보고 |
| `GET /api/desktop/mobile-sessions` | Desktop bearer | 연결된 모바일 세션·Push 상태 조회 |
| `DELETE /api/desktop/mobile-sessions/:id` | Desktop bearer | 모바일 세션과 해당 Push 구독 폐기 |
| `GET`, `DELETE /api/mobile/session` | Mobile HttpOnly cookie | 현재 모바일 세션 확인·로그아웃 |
| `GET`, `PUT /api/desktop/attendance` | Desktop bearer | 최신 출석 조회·snapshot 업로드 |
| `GET /api/mobile/attendance` | Mobile HttpOnly cookie | 연결 계정의 최신 출석 조회 |
| `POST /api/pairings`, `GET /api/pairings/:id` | Desktop bearer | 연결 생성·상태 조회 |
| `POST /api/pairings/:id/claims`, `POST /api/pairings/claims` | 일회용 proof/code | 모바일 연결 claim |
| `POST /api/pairings/:id/approve` | Desktop bearer | 표시된 모바일 연결 승인 |
| `POST /api/pairings/:id/complete` | 2분 pending-claim HttpOnly cookie | Mobile HttpOnly cookie 발급 |
| `GET /api/desktop/notifications` | Desktop bearer | 설치별 native notification delivery 조회 |
| `POST /api/desktop/notifications/:id/ack` | Desktop bearer | 해당 설치 delivery 결과 기록 |
| `GET /api/mobile/notifications` | Mobile HttpOnly cookie | 계정 notification history 조회 |
| `POST /api/{desktop\|mobile}/notifications/test` | 역할별 인증 | 계정의 모든 현재 delivery target에 테스트 알림 생성 |
| `GET /api/push/vapid-public-key` | Mobile HttpOnly cookie | 현재 Web Push 공개키 조회 |
| `PUT /api/push/subscriptions` | Mobile HttpOnly cookie | 현재 모바일 세션의 Web Push 구독 등록·갱신 |
| `DELETE /api/push/subscriptions/:id` | Mobile HttpOnly cookie | Web Push 구독과 남은 delivery 폐기 |
| `GET`, `PUT /api/{desktop\|mobile}/attendance/preferences` | 역할별 인증 | 출석 알림 설정 조회·수정 |
| `GET`, `PUT /api/{desktop\|mobile}/meal-preferences` | 역할별 인증 | 급식 알림 설정 조회·수정 |
| `GET`, `POST`, `DELETE /api/{desktop\|mobile}/laundry-watches` | 역할별 인증 | 세탁 상태 watch 조회·추가·취소 |
| `GET`, `POST`, `DELETE /api/{desktop\|mobile}/laundry-queue` | 역할별 인증 | 세탁 차례 알림 조회·추가·취소 |

Rate limit의 단일 기준은
[`DESKTOP_ENROLLMENT_POLICY`, `MANUAL_PAIRING_CLAIM_POLICY`, `PAIRING_CREATION_POLICY`](../src/domain/enrollment-policy.ts)입니다.
현재 고정 window 계약은 다음과 같습니다.

- Desktop 등록은 IP당 10분에 240회이고, 같은 IP와 installation 조합은 10분에
  10회입니다. IP 제한을 먼저 적용하므로 240회가 소진된 뒤 임의 installation ID로
  요청해도 추가 rate row를 만들지 않습니다.
- 수동 코드 claim은 IP당 2분에 240회이고, 같은 IP와 모바일 installation 조합은
  2분에 10회입니다. 스키마가 잘못된 installation ID는 rate state를 만들기 전에
  `400 INVALID_REQUEST`로 거부합니다.
- 페어링 생성은 인증된 desktop installation당 10분에 10회입니다. 만료되지 않은
  `pending` 또는 `claimed` 페어링은 desktop당 하나만 허용하며 추가 생성은
  `409 PAIRING_ALREADY_ACTIVE`, limit 초과는 `429 PAIRING_CREATION_RATE_LIMITED`입니다.
  기존 페어링이 만료되거나 `approved`·`consumed` 상태가 되면 새 페어링을 만들 수
  있습니다.

Desktop 앱과 명령줄 클라이언트를 위해 `POST /api/desktop/installations`는 `Origin`
header가 없어도 허용합니다. 등록 후 24시간 동안 heartbeat, 자격 증명 rotation,
페어링 생성 중 하나도 성공하지 않은 계정은 housekeeping이 사용자와 설치·세션·기본
설정을 FK cascade로 제거합니다. 유효한 모바일 세션이 있거나 위 사용 흔적이 기록된
계정은 이 정리 대상이 아닙니다.

테스트 알림 endpoint의 `202`는 알림 event와 현재 대상별 delivery가 D1에 생성됐다는
뜻입니다. App Worker가 운영체제 알림을 즉시 전송했다는 뜻이 아닙니다. Desktop
inbox는 다음 poll에서 조회하고 PWA Web Push는 다음 OCI Jobs tick에서 전송합니다.

페어링 생성과 승인은 strict 빈 객체 `{}`만 입력으로 받습니다. 페어링 claim 성공
응답은 `{ "claimId": "...", "status": "awaiting-desktop-approval" }`만
반환합니다. proof는 JSON이나 브라우저 JavaScript에 노출하지 않고 2분 만료의
`HttpOnly; SameSite=Strict` pending-claim cookie에만 저장합니다. 승인이 끝난 뒤
`POST /api/pairings/:id/complete`는 strict 빈 객체 `{}`를 받고 pending cookie로
proof를 검증합니다. 성공 시 pending cookie를 삭제하고 모바일 세션 cookie를
발급합니다.

`GET /api/mobile/attendance`는 다음 root envelope를 반환합니다. Desktop 출석
endpoint에는 `devices`를 추가하지 않습니다.

```json
{
  "attendance": null,
  "freshness": "missing",
  "devices": [
    {
      "id": "desktop-installation-id",
      "deviceLabel": "PC 앱",
      "lastSeenAt": "2026-08-03T00:00:00.000Z",
      "lmsSessionState": "connected",
      "health": "online",
      "appVersion": "0.5.0"
    }
  ]
}
```

`health`는 마지막 PC heartbeat가 현재 시각보다 5분 이내이고 허용된 5분의
미래 clock skew를 넘지 않을 때만 `online`입니다. 나머지는 `offline`입니다.
`GET /api/mobile/notifications`는 `{ "notifications": [...] }` 형태이며 각 항목의
`attempt`를 포함합니다.

Desktop bearer는 `/api/mobile/*`와 `/api/push/*`에 사용할 수 없습니다. 알림
delivery는 desktop installation 및 활성 Push subscription별로 생성되며 임의 PC
명령을 전달하는 queue로 사용하지 않습니다. 세션·구독 재연결, 명시적 폐기 또는
Push endpoint의 `410 Gone`이 확인되면 해당 target의 남은 pending/retry delivery도
즉시 실패 처리합니다.

Desktop 자격 증명은 90일 절대 만료이며 만료 전에
`POST /api/desktop/installations/rotate`로 교체해야 합니다. 만료되거나 로컬에서
유실된 자격 증명은 installation ID만으로 재발급하지 않습니다. 이 경우 새 installation
identity로 등록하고 모바일을 다시 페어링해야 합니다.

## 개인 설정과 세탁 차례 알림

출석 설정 응답은 `{ "morning": true, "evening": true, "skipSunday": false,
"skipAttendanceDate": null }`입니다. heartbeat는 이 값을 쓰지 않으며 명시적인
preferences endpoint만 설정의 기준 저장소를 변경합니다.

급식 설정 응답은 `enabled`, `breakfast`, `lunch`, `dinner`, `updatedAtEpochMs`를
포함합니다. 설정을 켜기 전에 수집된 과거 게시물은 재알림하지 않습니다. 새
`DAILY_MENU`의 `firstSeenAt`과 content 변경 감지 시각을 기준으로 조·중·석식
구독자를 선택하며, 12시간이 지난 이벤트는 처리 기준선만 기록합니다. 알림
dedupe는 `serviceDate`, meal period, `contentSha`로 결정됩니다.

세탁 watch ID는 `jbw_`와 64자리 소문자 hex, 차례 알림 ID는 `jbq_`와 64자리
소문자 hex입니다. 차례 알림은 외부 세탁기를 예약하거나 제어하지 않습니다.
최신 정규화 projection이 명시적으로 `IDLE`일 때 FIFO 선두 한 명에게만
best-effort 안내를 보내고 5분 동안 다음 안내를 막습니다. 5분 안에 실제 사용을
확인하거나 예약을 보장하지 않으며, 시간이 지나면 다음 대기자에게 안내할 수
있습니다. raw LG state 문자열이나 세탁 이벤트만으로 사용 가능을 판정하지 않습니다.

OCI Jobs는 D1 작업을 위 gateway로 실행하고, collector, 출석, 급식, 세탁,
housekeeping, Push 단계를 서로 격리합니다. 한 단계가 실패해도 이후 단계와 마지막
Push 전송은 계속 시도합니다.
housekeeping은 시간당 최대 한 번 실행하며 notification·세탁 기록과 만료·폐기된
desktop/mobile 세션은 30일, pairing artifact와 rate row는 7일 기준으로
정리합니다. 활성 세션, 최신 출석 상태, 활성 watch와 대기·진행 중 queue는 삭제하지
않습니다. 급식 처리 marker는 30일이 지난 과거 content version만 지우고 현재
`meal_post.contentSha` marker는 보존해 과거 게시물 재알림을 막습니다.
