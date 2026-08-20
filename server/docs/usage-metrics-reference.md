# 사용량 메트릭 레퍼런스

Jungle Bell 사용량은 외부 분석 서비스가 아니라 운영 PostgreSQL에 저장합니다. API가
허용된 원자료만 기록하고 Worker가 매시간 오늘·어제와 보존 중인 원자료 날짜를 다시
집계합니다. 같은 작업을 반복해도 요약 결과는 바뀌지 않습니다.

## 데이터 모델

| 테이블 | 식별 단위 | 저장 값 | 보존기간 |
| --- | --- | --- | --- |
| `usage_anonymous_day` | 날짜별 HMAC 방문자 | 날짜, Web/PWA, `ui_opened` | 2일 |
| `usage_user_day` | 서버 사용자 UUID | 날짜, Web/PWA/Desktop, `ui_opened` | 7일 |
| `usage_feature_day` | 서버 사용자 UUID | 날짜, client, 허용 기능 코드, 횟수 | 30일 |
| `usage_daily_summary` | 개인 식별자 없음 | 날짜, audience, 종류, client, 코드, 고유 수, 전체 횟수 | 730일 |

익명 쿠키는 24시간 유지합니다. DB에는 쿠키 원문이 아니라 전용 secret으로 날짜까지
포함해 계산한 HMAC만 저장하므로 날짜 사이의 동일 방문자를 연결할 수 없습니다.
인증 사용자 UUID와 익명 방문자 HMAC도 서로 연결하지 않습니다.

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
| `unique_subjects` | 해당 행의 고유 방문자 또는 사용자 수 |
| `total_count` | 일일 활동 행 수 또는 기능 실행 횟수 합계 |

`authenticated/all`은 같은 사용자가 여러 client를 사용해도 한 명으로 계산합니다.
`anonymous`와 `authenticated`는 연결할 수 없으므로 두 `unique_subjects`를 더한 값을
고유한 사람 수로 해석하면 안 됩니다.

## 조회 SQL

일별 UI 사용 주체 수는 audience를 분리해 조회합니다.

```sql
SELECT usage_date, audience, client, unique_subjects, total_count
FROM usage_daily_summary
WHERE metric_kind = 'activity'
  AND metric_code = 'ui_opened'
ORDER BY usage_date DESC, audience, client;
```

기능별 사용자 수와 실행 횟수는 다음과 같이 조회합니다.

```sql
SELECT usage_date, client, metric_code, unique_subjects, total_count
FROM usage_daily_summary
WHERE audience = 'authenticated'
  AND metric_kind = 'feature'
ORDER BY usage_date DESC, metric_code, client;
```

운영 HTTP admin endpoint는 제공하지 않습니다. 조회 권한은 PostgreSQL 운영 계정에서
별도로 제한합니다.

## 집계와 장애 동작

- Worker는 55분 lease를 획득한 한 instance에서만 매시간 집계합니다.
- 오늘·어제와 아직 남아 있는 원자료 날짜를 날짜순으로 재생성한 뒤 원자료를 삭제합니다.
- 통계 기록 실패는 화면 열기, 설정 저장, 연결, Push 구독 같은 업무 요청을 실패시키지 않습니다.
- `USAGE_METRICS_ENABLED=false`이면 신규 기록과 요약 재집계를 건너뛰지만, 기존
  원자료가 보존기간을 넘지 않도록 Worker의 삭제 작업은 계속 실행합니다.
