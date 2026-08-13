# HTTP API 레퍼런스

모든 JSON 요청은 알 수 없는 필드를 거부합니다. 오류 응답은 HTTP 상태와 안정적인
`code`를 포함합니다. 서버 시각은 UTC ISO 8601, 영속 시각은 epoch milliseconds를
사용합니다.

## 인증 방식

| 대상 | 자격 증명 | 허용 경로 |
| --- | --- | --- |
| 공개 웹 | 없음 | `/api/public/*`, `/api/health`, 정적 자산 |
| Tauri background | `Authorization: Bearer jbd_…` | `/api/desktop/*` |
| Tauri WebView | `Authorization: Bearer jbui_…`와 발급 시 등록한 exact `Origin` | `/api/desktop-ui/*` |
| 설치 PWA | `__Host-jb_device` Strict HttpOnly cookie | `/api/mobile/*`, `/api/push/*` |

PC 장기 credential은 90일 절대 만료이며 인증된 rotate만 허용합니다. WebView token은
7분 절대 만료, 메모리 전용, 부모 PC session당 하나입니다. 부모 session을 rotate,
폐기 또는 만료하면 즉시 무효화됩니다.

## 상태와 정적 자산

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/actuator/health/readiness` | OCI health check |
| `GET` | `/api/health` | 수집 source를 포함한 서비스 health |
| `GET` | `/api/public/status` | source별 최근 시도·성공·실패 상태 |
| `GET` | `/` | `/dashboard.html`로 308 redirect |
| `GET` | `/blog`, `/blog/` | `/blog/index.html`로 308 redirect |

React 대시보드와 Astro 블로그는 Spring Boot JAR의 정적 자산으로 함께 배포됩니다.

## 공개 세탁 데이터

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/public/laundry` | 최신 정규화 projection |
| `GET` | `/api/public/laundry/head` | 최신 minute/version 포인터 |
| `GET` | `/api/public/laundry/at?time=<ISO>` | 해당 immutable minute URL로 308 redirect |
| `GET` | `/api/public/laundry/minutes/{minute}` | 특정 분의 immutable observation |
| `GET` | `/api/public/laundry/versions/{sha}` | content SHA의 immutable 정규화 상태 |
| `GET` | `/api/public/laundry/events?since=<ISO>&limit=100` | 상태 변화 이벤트, limit 1–500 |

immutable 응답은 1년 cache를 사용합니다. 최신 응답은 짧은 shared cache와
stale-while-revalidate를 사용합니다.

## 공개 급식 데이터

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/public/meals` | 현재 중식·석식 게시물과 선택 주간표 |
| `GET` | `/api/public/meals/history?month=YYYY-MM` | 선택 달의 기록 |
| `GET` | `/api/public/assets/{sha}.{extension}` | PostgreSQL BYTEA에 저장한 급식 이미지 |

이미지는 SHA-256 기반 immutable URL로 제공하며 `nosniff`와 cross-origin resource
정책을 설정합니다. 조식 설정과 조식 알림은 존재하지 않습니다.

## PC 등록과 동기화

| Method | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/desktop/installations` | 새 PC와 사용자 생성, `jbd_` credential 발급 |
| `POST` | `/api/desktop/installations/rotate` | 현재 PC credential 교체 |
| `POST` | `/api/desktop/webview-sessions` | exact origin에 묶인 `jbui_` token 발급 |
| `DELETE` | `/api/desktop/webview-sessions/current` | 해당 origin의 WebView token 폐기 |
| `POST` | `/api/desktop/heartbeat` | LMS 상태와 앱 버전 갱신 |
| `GET` | `/api/desktop/attendance` | 최근 출석 snapshot |
| `PUT` | `/api/desktop/attendance` | checker가 정규화한 출석 snapshot 저장 |
| `GET` | `/api/desktop/mobile-sessions` | 연결된 모바일 목록 |
| `DELETE` | `/api/desktop/mobile-sessions/{id}` | 모바일 session 폐기 |

등록 endpoint는 10분 창에서 IP당 240회, installation ID당 10회로 제한합니다. rate
key에는 원문 IP나 installation ID를 저장하지 않고 SHA-256 hash만 저장합니다.

## WebView 개인 API

다음 endpoint는 `/api/desktop-ui` 아래에 있습니다.

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/attendance` | 최근 출석 snapshot |
| `GET`, `PUT` | `/attendance/preferences` | 출석 알림 활성화·시간·간격 설정 |
| `GET`, `PUT` | `/meal-preferences` | 중식·석식 알림 설정 |
| `GET`, `POST` | `/laundry-watches` | 개인 세탁 알림 목록·생성 |
| `DELETE` | `/laundry-watches/{id}` | 세탁 알림 제거 |
| `POST` | `/pairings` | QR·수동 코드를 포함한 pairing 생성 |
| `GET` | `/pairings/{id}` | pairing 상태 |
| `POST` | `/pairings/{id}/approve` | `{ "claimId": "…" }` 승인 |
| `GET` | `/mobile-sessions` | 연결된 모바일 목록 |
| `DELETE` | `/mobile-sessions/{id}` | 모바일 연결 해제 |

WebView bearer는 다른 namespace에 사용할 수 없습니다. 허용 origin은
`tauri://localhost`, `http://tauri.localhost`, `http://127.0.0.1:5173`뿐입니다.

## Pairing과 모바일 session

| Method | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/pairings/{id}/claims` | QR proof로 pairing claim |
| `POST` | `/api/pairings/claims` | 10자리 수동 코드로 pairing claim |
| `POST` | `/api/pairings/{id}/complete` | PC 승인 후 모바일 session cookie 발급 |
| `GET` | `/api/mobile/session` | 현재 모바일 session 상태 |
| `DELETE` | `/api/mobile/session` | 현재 모바일 session 폐기 |
| `GET` | `/api/mobile/attendance` | 출석 snapshot과 PC 상태 |

claim receipt는 JSON에 노출하지 않고 2분짜리 Strict HttpOnly pending cookie에만
저장합니다. 승인 완료 시 최대 365일의 모바일 session cookie를 발급합니다.

## 모바일 개인 API

다음 기능은 `/api/mobile`에서도 PC WebView와 같은 DTO를 사용합니다.

- `GET`, `PUT /attendance/preferences`
- `GET`, `PUT /meal-preferences`
- `GET`, `POST /laundry-watches`
- `DELETE /laundry-watches/{id}`

연결된 모바일이 0개인 상태는 오류가 아니라 정상적인 빈 목록입니다.

## 알림과 Push

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/desktop/notifications?limit=20` | PC delivery polling |
| `POST` | `/api/desktop/notifications/{id}/ack` | PC delivery 결과 반영 |
| `POST` | `/api/desktop/notifications/test` | PC 테스트 알림 계획 |
| `GET` | `/api/mobile/notifications?limit=20` | 모바일 알림 목록 |
| `POST` | `/api/mobile/notifications/test` | Push 테스트 알림 계획 |
| `GET` | `/api/push/vapid-public-key` | 현재 VAPID public key |
| `PUT` | `/api/push/subscriptions` | 현재 모바일 session의 구독 등록 |
| `DELETE` | `/api/push/subscriptions/{id}` | 구독 해제 |

테스트 endpoint의 `202`는 notification과 delivery가 PostgreSQL에 생성됐다는 뜻입니다.
운영체제 표시 또는 Push provider 전달 성공을 의미하지 않습니다. background scheduler가
pending delivery를 전송하고 retry/backoff를 관리합니다.

## 저장 범위

서버에는 정규화된 출석 snapshot, PC·모바일 session hash, 기기 metadata, 개인 설정,
세탁 watch, Push subscription key, pairing 상태, 알림 delivery, 공개 세탁·급식 기록을
저장합니다. LMS cookie, LMS token, Google SSO credential, LMS 페이지 원문은 저장하지
않습니다.
