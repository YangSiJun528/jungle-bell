# HTTP API 레퍼런스

모든 JSON 요청은 알 수 없는 필드를 거부합니다. 오류 응답은 HTTP 상태와 안정적인
`code`를 포함합니다. 서버 시각은 UTC ISO 8601, 영속 시각은 epoch milliseconds를
사용합니다.

## 요청 식별자

클라이언트는 `X-Request-ID` 요청 header를 보낼 수 있습니다. 서버는 허용된 형식이면
그 값을 유지하고, 누락되거나 형식이 맞지 않으면 UUID를 생성합니다. 성공과 오류를
포함한 모든 응답에 최종 `X-Request-ID`를 반환합니다. 브라우저 요청에서는 CORS
`Access-Control-Expose-Headers`에도 이 header를 포함합니다.

## 인증 방식

| 대상 | 자격 증명 | 허용 경로 |
| --- | --- | --- |
| 공통 SPA 공개 기능 | 없음 | `/api/public/*`, `/api/health`, 정적 자산 |
| Tauri background | `Authorization: Bearer jbd_…` | `/api/desktop/*`, `POST /api/me/usage/ui-opened` |
| Tauri SPA | `Authorization: Bearer jbui_…`와 발급 시 등록한 exact `Origin` | `/api/me/*` |
| 설치형 PWA | `__Host-jb_device` Strict HttpOnly cookie | `/api/me/*` |

PC 장기 credential은 90일 절대 만료이며 인증된 rotate만 허용합니다. WebView token은
7분 절대 만료, 메모리 전용, 부모 PC session당 하나입니다. 부모 session을 rotate,
폐기 또는 만료하면 즉시 무효화됩니다.

세 형식 모두 Spring Security의 opaque-token Resource Server에서 검증합니다. 모바일
cookie는 token resolver에서 Bearer 인증으로 변환하고, 권한과 WebView exact origin은
`SecurityFilterChain`에서 판정합니다.

## 상태와 정적 자산

Actuator는 공개 HTTP API가 아닙니다. 운영에서는 별도 management port를 호스트
loopback에만 publish하며, Tailscale SSH 후 조회합니다. Cloudflare Tunnel의 API port에서
`/actuator/*`는 `404`입니다.

| 범위 | Method | 경로 | 설명 |
| --- | --- | --- | --- |
| 내부 management | `GET` | `/actuator/health/readiness` | 운영 readiness health check |
| 내부 management | `GET` | `/actuator/info` | 수치나 식별자 없이 사용량 설정·DB·집계 상태 제공 |
| 공개 API | `GET` | `/api/health` | 수집 source를 포함한 서비스 health |
| 공개 API | `GET` | `/api/public/status` | source별 최근 시도·성공·실패 상태 |
| 공개 자산 | `GET` | `/`, `/index.html` | 내장 React SPA HTML |

Vite로 빌드한 React SPA는 Spring Boot JAR의 정적 자산으로 배포됩니다. 화면 이동은 `/#/home`, `/#/attendance`, `/#/laundry`, `/#/meals` hash 경로를 사용하고 개인정보 처리 안내는 인증과 무관하게 `/#/privacy`에서 엽니다.

## 사용량 기록

| Method | 경로 | 인증 | 설명 |
| --- | --- | --- | --- |
| `POST` | `/api/public/usage/ui-opened` | 없음 | `{ "client": "web" | "pwa" }`, 24시간 HttpOnly 방문자 쿠키 발급·일일 중복 제거 |
| `POST` | `/api/me/usage/ui-opened` | PC 장기 bearer 또는 모바일 cookie | 인증 session에서 사용자와 Desktop/PWA를 결정해 일일 중복 제거 |
| `GET` | `/api/public/usage-preference` | 없음 | 익명 수집 허용 여부를 `{ "enabled": boolean }`로 조회 |
| `PUT` | `/api/public/usage-preference` | 없음 | 익명 수집 허용 여부 저장, body `{ "enabled": boolean }` |
| `GET` | `/api/me/usage-preference` | Tauri SPA 또는 모바일 cookie | 연결 계정 값을 `{ "enabled": boolean \| null }`로 조회 |
| `GET` | `/api/desktop/usage-preference` | PC 장기 bearer | 연결 계정 값을 `{ "enabled": boolean \| null }`로 조회 |
| `PUT` | `/api/desktop/usage-preference` | PC 장기 bearer | 계정 값을 저장, body `{ "enabled": boolean }` |

UI 열기 원자료는 endpoint를 처리하는 API 요청 thread에서 PostgreSQL에 동기식으로
기록합니다. Worker는 ingestion을 수행하지 않고 일별 요약과 보존기간 삭제만 담당합니다.

두 UI 열기 endpoint의 응답 의미는 같습니다.

| 응답 | 의미 |
| --- | --- |
| `204 No Content` | 신규 기록, 일일 중복, 전역 비활성화 또는 preference에 따른 생략 중 하나 |
| `503 Service Unavailable` | 일시적 DB 실패. `Retry-After: 1`과 `{ "error": "USAGE_METRICS_UNAVAILABLE" }` 포함 |
| `500 Internal Server Error` | 예상하지 못한 DB 또는 서버 실패 |

`204`는 원자료 삽입이나 Worker 집계 완료를 보장하지 않습니다. 익명 endpoint는 `503`인
경우에도 재시도에서 같은 주체를 사용하도록 새 방문자 쿠키를 발급할 수 있습니다.

계정 preference의 `null`은 결정 대기이며 유효 상태는 OFF입니다. `false`는 명시적
OFF, `true`는 ON입니다. 현재 PC만 계정 preference를 편집합니다. 연결된 PWA는 같은
서버 값을 읽고 적용받지만 `PUT /api/me/usage-preference`는 허용하지 않습니다.
OFF는 이후 기록만 막으며 기존 원자료와 요약을 즉시 삭제하지 않습니다.

익명 preference는 계정 preference와 별개입니다. 운영 HTTPS에서는 1년짜리
`__Host-jb_usage_opt_out` HttpOnly·Secure·SameSite=Strict 쿠키를 사용하고, 로컬
HTTP에서는 `jb_usage_opt_out`을 사용합니다. OFF로 바꿀 때 24시간 방문자 쿠키
`__Host-jb_usage` 또는 `jb_usage`를 만료시킵니다. 공개 익명 preference 응답은
`Cache-Control: no-store`를 명시합니다. 쿠키 만료는 이미 저장된 날짜별 HMAC 원자료를
즉시 삭제하지 않습니다.

클라이언트가 임의 기능 이벤트를 제출하는 API는 없습니다. 기능 사용량은 허용된 서버 기능이
성공한 직후 같은 업무 요청에서 best-effort으로 기록합니다. 메트릭 기록 실패는 성공한
업무 응답을 실패시키지 않습니다. 상세 스키마와 보존기간은
[사용량 메트릭 레퍼런스](./usage-metrics-reference.md)를 따릅니다.

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
| `POST` | `/api/desktop/installations` | 새 PC와 사용자 생성, nullable 수집 preference 반영, `jbd_` credential 발급 |
| `DELETE` | `/api/desktop/installations/current` | 현재 PC 사용자와 모든 session·개인 데이터 삭제 |
| `POST` | `/api/desktop/installations/rotate` | 현재 PC credential 교체 |
| `POST` | `/api/desktop/webview-sessions` | exact origin에 묶인 `jbui_` token 발급 |
| `DELETE` | `/api/desktop/webview-sessions/current` | 해당 origin의 WebView token 폐기 |
| `POST` | `/api/desktop/heartbeat` | LMS 상태와 앱 버전 갱신 |
| `GET` | `/api/desktop/attendance` | 최근 출석 snapshot |
| `PUT` | `/api/desktop/attendance` | checker가 정규화한 출석 snapshot 저장 |
| `GET` | `/api/me/mobile-sessions` | WebView token으로 연결된 모바일 목록 조회 |
| `DELETE` | `/api/me/mobile-sessions/{id}` | WebView token으로 모바일 session 폐기 |

등록 endpoint는 10분 창에서 IP당 240회, installation ID당 10회로 제한합니다. rate
key에는 원문 IP나 installation ID를 저장하지 않고 SHA-256 hash만 저장합니다.

등록 body는 다음 형식입니다. `usageAnalyticsEnabled`는 `true`, `false`, `null`을
허용하며 필드를 생략해도 `null`입니다. `null`은 계정 preference를 만들지 않으므로
결정 대기·유효 OFF 상태입니다.

```json
{
  "installationId": "desktop-installation-id",
  "usageAnalyticsEnabled": null
}
```

## 공통 계정 API

다음 endpoint는 `/api/me` 아래에 있습니다. 같은 DTO와 경로를 브라우저와 Tauri가
공유하며 인증 어댑터만 다릅니다. 모바일 관리와 pairing 승인은 Tauri session만
허용합니다.

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
| `GET`, `DELETE` | `/session` | 현재 브라우저 session 조회·해제 |
| `GET` | `/notifications?limit=20` | 계정 알림 목록 |
| `POST` | `/notifications/test` | Push 테스트 알림 계획 |
| `GET` | `/push/vapid-public-key` | 현재 VAPID public key |
| `PUT` | `/push/subscriptions` | 현재 브라우저 session의 구독 등록 |
| `DELETE` | `/push/subscriptions/{id}` | 구독 해제 |

WebView bearer는 다른 namespace에 사용할 수 없습니다. 허용 origin은
`tauri://localhost`, `http://tauri.localhost`, `http://127.0.0.1:5173`뿐입니다.

## Pairing과 모바일 session

| Method | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/pairings/{id}/claims` | QR proof로 pairing claim |
| `POST` | `/api/pairings/claims` | 10자리 수동 코드로 pairing claim |
| `POST` | `/api/pairings/{id}/handoff` | QR proof를 설치용 HttpOnly cookie로 교환 |
| `POST` | `/api/pairings/handoffs/claims` | 설치형 PWA가 handoff cookie로 pairing claim |
| `POST` | `/api/pairings/{id}/complete` | PC 승인 후 모바일 session cookie 발급 |
| `GET` | `/api/me/session` | 현재 브라우저 session 상태 |
| `DELETE` | `/api/me/session` | 현재 브라우저 session 폐기 |
| `GET` | `/api/me/attendance` | 출석 snapshot과 PC 상태 |

pairing, handoff cookie, pending claim은 10분 동안 유효합니다. handoff endpoint는
pairing을 claim하지 않으며 설치 전 브라우저와 설치형 PWA 사이에 일회용 challenge만
전달합니다. handoff cookie가 없으면 claim endpoint는 `204`를 반환해 PWA가 10자리
수동 코드 입력으로 복구하게 합니다. claim receipt는 JSON에 노출하지 않고
Secure·Strict HttpOnly pending cookie에만 저장합니다. 승인 완료 시 최대 30일의
모바일 session cookie를 발급합니다.

연결된 모바일이 0개인 상태는 오류가 아니라 정상적인 빈 목록입니다.

## 알림과 Push

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/desktop/notifications?limit=20` | PC delivery polling |
| `POST` | `/api/desktop/notifications/{id}/ack` | PC delivery 결과 반영 |
| `POST` | `/api/desktop/notifications/test` | PC 테스트 알림 계획 |
| `GET` | `/api/me/notifications?limit=20` | 계정 알림 목록 |
| `POST` | `/api/me/notifications/test` | Push 테스트 알림 계획 |
| `GET` | `/api/me/push/vapid-public-key` | 현재 VAPID public key |
| `PUT` | `/api/me/push/subscriptions` | 현재 브라우저 session의 구독 등록 |
| `DELETE` | `/api/me/push/subscriptions/{id}` | 구독 해제 |

테스트 endpoint의 `202`는 notification과 delivery가 PostgreSQL에 생성됐다는 뜻입니다.
운영체제 표시 또는 Push provider 전달 성공을 의미하지 않습니다. background scheduler가
pending delivery를 전송하고 retry/backoff를 관리합니다.

## 저장 범위

서버에는 정규화된 출석 snapshot, PC·모바일 session hash, 기기 metadata, 개인 설정,
세탁 watch, Push subscription key, pairing 상태, 알림 delivery, 공개 세탁·급식 기록,
최소 사용량 원자료와 일별 집계를
저장합니다. LMS cookie, LMS token, Google SSO credential, LMS 페이지 원문은 저장하지
않습니다.
