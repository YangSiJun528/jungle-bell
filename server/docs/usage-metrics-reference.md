# 사용량 메트릭 레퍼런스

Jungle Bell 사용량은 외부 분석 서비스가 아니라 운영 PostgreSQL에 저장합니다. 허용된
필드와 코드만 원자료로 기록하고, 개인 식별자를 제거한 일별 요약을 별도로 보존합니다.

## 처리 경로

사용량 기록 endpoint를 처리하는 API 요청 thread가 PostgreSQL에 원자료를 동기식으로
`INSERT` 또는 `UPSERT`합니다. 별도 ingestion queue는 없으며 Worker는 API 요청을
수집하거나 나중에 원자료로 변환하지 않습니다.

Worker는 매시간 다음 후처리만 수행합니다.

- `usage_daily_summary` 재집계
- 원자료와 요약의 보존기간 삭제
- 집계 lease와 마지막 전체 성공 시각 기록

기능 메트릭은 허용된 업무 동작이 성공한 직후 같은 API 요청에서 기록합니다. 기능
메트릭 저장은 best-effort이므로 preference 조회나 `UPSERT`가 실패해도 원래 업무
응답은 실패시키지 않고 경고 로그만 남깁니다.

## UI 열기 응답 계약

`POST /api/me/usage/ui-opened`와 `POST /api/public/usage/ui-opened`는 다음 상태를
사용합니다.

| 상태 | 의미 |
| --- | --- |
| `204 No Content` | 새 원자료 기록, 일일 중복 제거, 전역 비활성화 또는 사용자 정책에 따른 생략 중 하나 |
| `503 Service Unavailable` | 일시적·복구 가능한 DB 실패. `Retry-After: 1`과 `USAGE_METRICS_UNAVAILABLE` 오류 코드 포함 |
| `500 Internal Server Error` | 예상하지 못한 DB 또는 서버 실패 |

따라서 `204`만으로 원자료 행이 새로 생겼다고 판단할 수 없습니다. 일일 기본키가 이미
있거나, 계정 preference가 `true`가 아니거나, 익명 거부 쿠키가 있거나,
`USAGE_METRICS_ENABLED=false`여도 `204`입니다. Worker 완료 여부도 이 응답과 관계없습니다.

## 수집 preference

### 인증 계정

계정 preference는 `usage_preference`에 저장되며 연결된 Desktop과 PWA에 함께 적용됩니다.

| `enabled` | 유효 상태 |
| --- | --- |
| `null` | 결정 대기. 수집하지 않는 OFF로 처리 |
| `false` | 명시적 OFF |
| `true` | 명시적 ON |

현재 지원하는 편집자는 PC입니다. PC 장기 bearer가
`PUT /api/desktop/usage-preference`로 값을 바꾸고, 연결된 PWA는
`GET /api/me/usage-preference`로 같은 값을 읽습니다. PWA에서 계정 preference를 직접
수정하는 API는 허용하지 않습니다.

새 Desktop 등록의 `usageAnalyticsEnabled`는 nullable입니다. `true`나 `false`이면 계정
preference를 함께 만들고, 생략하거나 `null`이면 preference를 만들지 않아 결정 대기
상태를 유지합니다.

OFF는 이후 기록만 막고 기존 원자료나 요약을 즉시 삭제하지 않습니다. PC 계정 삭제는
`app_user`를 삭제하므로 해당 계정의 인증 활동·기능 원자료는 FK cascade로 삭제됩니다.
개인 식별자가 없는 기존 요약은 직접 cascade되지 않으며, 보존 범위 안의 날짜가 이후
재집계 대상이 되면 남은 원자료 기준으로 조정될 수 있습니다.

### 익명 Web/PWA

일반 Web과 인증이 끊긴 PWA의 익명 수집 거부는 계정 preference와 분리된 1년
HttpOnly·SameSite=Strict 쿠키로 저장합니다. 거부할 때 기존 24시간 방문자 쿠키를
삭제합니다. 운영 HTTPS에서는 쿠키 이름에 `__Host-` prefix와 `Secure` 속성을
사용합니다. 이미 저장된 날짜별 HMAC 원자료와 요약은 즉시 삭제하지 않습니다.

## 데이터 모델과 보존기간

보존기간의 기준 zone은 `Asia/Seoul`입니다. Worker는 `usage_date < 오늘 - 보존일수`인
행을 삭제합니다.

| 테이블 | 식별 단위 | 저장 값 | 설정 보존기간 |
| --- | --- | --- | --- |
| `usage_anonymous_day` | 날짜별 HMAC 방문자 | 날짜, Web/PWA, `ui_opened` | 2일 |
| `usage_user_day` | 서버 계정 UUID | 날짜, Web/PWA/Desktop, `ui_opened` | 7일 |
| `usage_feature_day` | 서버 계정 UUID | 날짜, client, 허용 기능 코드, 횟수 | 30일 |
| `usage_daily_summary` | 개인 식별자 없음 | 날짜, audience, 종류, client, 코드, 고유 수, 전체 횟수, 계산 시각 | 730일 |

2일·7일·30일·730일은 Worker가 실행하는 삭제 cutoff 정책입니다. 해당 기간 동안 데이터
존재를 보장하는 최소 보존기간이나 가용성 SLA가 아닙니다. Worker가 중단되면 재집계와
삭제가 모두 늦어질 수 있고, 성공적으로 생성되지 않은 요약을 730일 보장하지 않습니다.

익명 방문자 쿠키는 24시간 유지합니다. DB에는 쿠키 원문이 아니라 전용 secret과 날짜를
포함해 계산한 HMAC만 저장하므로 날짜 사이의 동일 방문자를 연결할 수 없습니다. 인증
계정 UUID와 익명 방문자 HMAC도 서로 연결하지 않습니다.

## 식별 단위와 수치 해석

`unique_subjects`는 자연인 수가 아닙니다.

- `authenticated`는 `app_user.id`의 distinct 수입니다. 현재 Desktop 등록은 설치
  identity에 대응하는 서버 계정을 만들고 연결된 PWA가 그 계정을 공유합니다.
- `client=desktop`은 Desktop bearer로 활동한 서버 계정 수입니다. 고유한 사람이나 물리
  PC 수를 보장하지 않습니다. 재설치·identity reset은 새 계정을 만들 수 있고 한 사람이
  여러 설치를 사용하거나 여러 사람이 한 설치를 공유할 수 있습니다.
- `anonymous`는 해당 날짜의 HMAC 방문자 수입니다. 쿠키 삭제·만료나 다른 브라우저는
  별도 주체로 계산되며 날짜 사이에 연결되지 않습니다.
- UUID 계정 수와 HMAC 방문자 수를 더해 전체 고유 사용자 수로 해석하면 안 됩니다.

## 허용 코드

활동 코드는 `ui_opened` 하나입니다. 기능 코드는 다음 값만 허용합니다.

| 기능 코드 | 기록 시점 |
| --- | --- |
| `attendance_settings_changed` | 출석 설정 저장 성공 |
| `meal_notification_settings_changed` | 식단 알림 설정 저장 성공 |
| `laundry_watch_created` | 세탁 알림 생성 성공 |
| `laundry_watch_cancelled` | 세탁 알림 취소 성공 |
| `mobile_device_paired` | 모바일 연결 승인 성공 |
| `mobile_device_revoked` | 모바일 연결 해제 성공 |
| `push_subscription_registered` | Push 구독 저장 성공 |
| `push_subscription_removed` | Push 구독 해제 성공 |

URL, 화면 입력값, 임의 JSON, LMS 식별자와 콘텐츠는 기록하지 않습니다.

## 요약 필드

| 필드 | 값 |
| --- | --- |
| `audience` | `anonymous`, `authenticated` |
| `metric_kind` | `activity`, `feature` |
| `client` | `web`, `pwa`, `desktop`, 모든 client를 합친 `all` |
| `metric_code` | 활동 또는 기능 허용 코드 |
| `unique_subjects` | 해당 행의 distinct HMAC 방문자 또는 서버 계정 수 |
| `total_count` | 일일 활동 행 수 또는 기능 실행 횟수 합계 |
| `calculated_at_epoch_ms` | 해당 요약 행을 마지막으로 계산한 epoch milliseconds |

`authenticated/all`은 같은 계정이 여러 client를 사용해도 한 계정으로 계산합니다.

## 집계와 보존 범위

Worker는 55분 lease를 획득한 한 instance에서만 실행합니다. 전역 수집이 켜져 있으면
오늘·어제와 원자료가 남아 있는 최근 날짜를 날짜순으로 재집계합니다. 날짜별 재집계
scope는 각 원자료 보존기간과 일치합니다.

- `usage_date >= 오늘 - 2일`: 익명 활동
- `usage_date >= 오늘 - 7일`: 인증 활동
- `usage_date >= 오늘 - 30일`: 인증 기능

예를 들어 인증 활동 원자료가 만료됐지만 기능 원자료가 남은 날짜는 기능 scope만 다시
계산합니다. 이때 이미 만들어진 인증 활동 요약을 빈 값으로 덮어쓰거나 삭제하지 않습니다.
모든 대상 scope의 재집계와 네 종류의 보존기간 삭제가 끝난 뒤에만
`usage-daily-summary-v1:success` marker를 갱신합니다.

`USAGE_METRICS_ENABLED=false`이면 신규 기록과 요약 재집계를 생략합니다. 기존
원자료·요약의 보존기간 삭제와 성공 marker 갱신은 계속 수행합니다.

## 운영 상태

API의 내부 management `GET /actuator/info`는 다음 `usageMetrics` 필드만 제공합니다.
운영에서는 Tailscale SSH 후 호스트 loopback으로 조회하며 Cloudflare Tunnel에는
연결하지 않습니다. 수치, 계정 UUID, HMAC, 원자료 최근 시각은 포함하지 않습니다.

| 필드 | 의미 |
| --- | --- |
| `configured` | API의 `USAGE_METRICS_ENABLED` 해석값 |
| `database` | 성공 marker 조회 결과 `available` 또는 `unavailable` |
| `aggregation` | `never`, `fresh`, `stale`, `unavailable` |
| `lastSuccessfulAggregationAt` | 성공 marker가 있을 때만 표시하는 UTC ISO 8601 시각 |

성공 marker가 현재 시각보다 130분 넘게 오래되면 `stale`입니다. Worker는 HTTP server를
열지 않습니다. API readiness에는 `readinessState`와 `db`가 포함되고 상세 내용은
노출하지 않습니다.

실제 수집과 집계를 확인하는 명령은 [서버 운영 절차](../OPERATIONS.md#사용량-수집과-집계-확인)를
따릅니다.
