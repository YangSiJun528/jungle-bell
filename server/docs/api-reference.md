# HTTP API 레퍼런스

API Worker는 공개 읽기 전용 Hono API입니다. 사용자별 설정은 저장하지 않으며 모든 사용자에게 같은 응답을 제공합니다.

## 공통 캐시 정책

| 응답 종류 | `Cache-Control` |
| --- | --- |
| 최신 상태, 이벤트, 식단 | `public, max-age=15, s-maxage=30, stale-while-revalidate=120` |
| 분 단위 이력, SHA 버전, 이미지 | `public, max-age=31536000, immutable` |
| 오류와 health check | `no-store` |

공개 GET 응답은 Cloudflare Cache API에도 저장됩니다. JSON 응답과 이미지는 `ETag` 조건부 요청을 지원합니다.

## 상태 엔드포인트

### `GET /healthz`

Collector 신선도를 확인합니다. 정상은 `200 OK`, 수집 지연 또는 연속 실패는 `503 DEGRADED`입니다.

### `GET /v1/status`

세 원본의 마지막 시도, 마지막 성공, 원본 SHA, 연속 실패 횟수를 반환합니다.

## 세탁기 엔드포인트

### `GET /v1/laundry/head`

현재 세탁 원본 버전 포인터와 마지막 정상 수집 시각을 반환합니다.

### `GET /v1/laundry/latest`

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

### `GET /v1/laundry/at?time=<RFC3339>`

주어진 시각을 UTC 분으로 내림한 뒤 정규 분 URL로 `308` 리다이렉트합니다.

### `GET /v1/laundry/minutes/:YYYYMMDDTHHmmZ`

해당 분의 불변 관측을 반환합니다. 수집이 실패한 분에도 직전 정상 버전이 있으면 그 값을 `COLLECTION_GAP` 품질로 반환합니다.

응답의 `data.final: true`는 이 분의 API 결과가 더 이상 바뀌지 않는다는 뜻입니다. 세탁 완료를 뜻하지 않습니다.

### `GET /v1/laundry/versions/:sha`

해당 원본 JSON SHA가 처음 나타났을 때의 정규화본을 반환합니다. 같은 SHA가 나중에 다시 나타난 정확한 발생 시점은 분 단위 엔드포인트로 조회합니다.

### `GET /v1/laundry/events?since=<RFC3339>&limit=100`

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

### `GET /v1/meals`

pinned 주간 식단표, 현재 중식·석식 게시물, 기타 게시물을 구분해 반환합니다. 각 게시물의 `contentSha`는 제목, 본문, 이미지 콘텐츠 SHA 목록으로 계산하며 게시 시각이나 CDN URL 변경은 포함하지 않습니다.

`data.currentWeeklyMenu`는 현재 화면에 표시할 주간 식단표의 판정 결과입니다. `targetWeekKey`는 해당 주의 월요일이며, 일요일에는 다음 날 월요일을 사용합니다. pinned 게시물 제목의 `N월 N주차`를 식단 제공자의 첫 월요일 기준으로 변환한 주차가 `targetWeekKey`와 일치할 때만 `status`가 `AVAILABLE`이고 `post`가 존재합니다. 아직 이전 주 pinned 게시물만 있으면 `AWAITING_UPDATE`와 `post: null`을 반환합니다. 과거 버전은 `data.weeklyMenus`에 계속 보존됩니다.

`data.recentMenus`에는 카카오 최신 목록에서 제거된 게시물도 포함한 최근 식단 최대 30개가 들어갑니다. 각 이미지에는 원본 카카오 URL, 콘텐츠 SHA, 보관 객체 키, API 이미지 URL이 포함됩니다.

### `GET /v1/meals/history?before=<RFC3339>&limit=30`

D1에 누적된 과거 식단을 최신순으로 반환합니다. `limit` 범위는 1부터 100이며 `nextBefore`가 있으면 다음 요청의 `before`로 사용합니다. 카카오에서 게시물이 제거되어도 수집된 본문과 이미지 메타데이터는 이 엔드포인트에서 계속 조회할 수 있습니다.

### `GET /v1/assets/:sha.:extension`

R2에 보관된 식단 이미지를 반환합니다. 콘텐츠 SHA 주소이므로 1년 immutable 캐시를 사용합니다.
