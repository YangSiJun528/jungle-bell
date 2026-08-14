# 플랫폼 계약 레퍼런스

## 지원 surface

| 기능 | 일반 웹 | 설치 PWA | Tauri PC |
| --- | --- | --- | --- |
| 홈 요약 | 공개 정보만 | 전체 | 전체 |
| 급식·세탁 조회 | 예 | 예 | 예 |
| 출석·D-Day | 로그인 안내 | 서버 snapshot | 서버 snapshot |
| LMS 주기 조회 | 아니요 | 아니요 | 예 |
| 알림 | 설치 안내 | Web Push | 운영체제 알림 |
| 모바일 연결 | 아니요 | 수동 코드·해제 | QR·코드 생성, 승인·해제 |
| Jungle Campus | 외부 바로가기 | 외부 바로가기 | 전용 WebView와 상태 |
| PC 서비스 설정 | 아니요 | PC 안내 | 자동 시작·업데이트, 사용 통계, 디버그, 로그 폴더 |

PWA surface는 URL 경로가 아니라 `display-mode: standalone` 또는 iOS standalone
상태로 판정합니다. 이는 UI 분기일 뿐 보안 증명이 아닙니다. 서버 권한은 HttpOnly
session 또는 bearer와 사용자·기기 소유권 검사로 결정합니다.

## 서버 런타임

서버는 `core`, `api`, `worker`의 세 Gradle 모듈로 나뉩니다. API와 Worker는 별도
Spring Boot 프로세스로 실행하고 PostgreSQL 접근과 도메인 로직은 Core를 공유합니다.
세 프로세스는 OCI Docker Compose로 실행합니다.

| 항목 | 계약 |
| --- | --- |
| API | Spring MVC |
| 인증 | Spring Security stateless opaque-token Resource Server |
| 영속성 | Spring Data JDBC, PostgreSQL 17 |
| 수집·알림 | Worker의 Spring Scheduler, API와 별도 JVM |
| 급식 이미지 | PostgreSQL `BYTEA`, SHA-256 immutable URL |
| 정적 자산 | Vite + React 빌드 결과를 API JAR에 포함 |
| 외부 ingress | 선택적인 Cloudflare Tunnel. 실행·저장 계층이 아님 |

Cloudflare Worker, D1, R2, Wrangler와 별도 TypeScript Jobs는 사용하지 않습니다.

## HTTP surface

사용자 API는 `/api` 계약만 제공합니다. 이전 `/v1` alias와 내부 SQL/object gateway는
제공하지 않습니다.

| 영역 | endpoint |
| --- | --- |
| 상태 | `GET /api/health`, `GET /api/public/status` |
| 공개 세탁 | `GET /api/public/laundry`, `/head`, `/at`, `/minutes/:minute`, `/versions/:sha`, `/events` |
| 공개 급식 | `GET /api/public/meals`, `GET /api/public/meals/history` |
| 공개 자산 | `GET /api/public/assets/:sha.:extension` |
| PC 등록 | `POST /api/desktop/installations`, `POST /api/desktop/installations/rotate` |
| PC WebView session | `POST /api/desktop/webview-sessions`, `DELETE /api/desktop/webview-sessions/current` |
| PC 동기화 | `POST /api/desktop/heartbeat`, `GET\|PUT /api/desktop/attendance` |
| PC 알림 | `GET /api/desktop/notifications`, ack, test |
| 모바일 관리 | `GET /api/desktop/mobile-sessions`, `DELETE /api/desktop/mobile-sessions/:id` |
| pairing | PC 생성·상태·승인과 모바일 claim·complete |
| 브라우저 session | `GET\|DELETE /api/me/session` |
| 공통 계정 정보 | `/api/me` 아래 출석, 설정, 세탁 watch, 알림 |
| PC 전용 계정 관리 | `/api/me` 아래 pairing 승인과 모바일 관리, WebView bearer만 허용 |
| Push | VAPID 공개키, subscription 등록·해제 |

자세한 경로와 인증 방식은 `server/docs/api-reference.md`를 기준으로 합니다.

## 인증과 연결

| 항목 | 계약 |
| --- | --- |
| PC credential | `jbd_…`, 최대 90일, 만료 전 인증된 rotate |
| PC 저장 | Windows Credential Manager. macOS·Linux는 앱 전용 mode 0600 파일 |
| PC WebView session | `jbui_…`, 7분 절대 만료, 메모리 전용, 부모 PC session당 하나 |
| WebView origin | release `tauri://localhost`·`http://tauri.localhost`, dev `http://127.0.0.1:5173` |
| pairing | QR 또는 10자리 코드, 2분 유효, PC 명시 승인 |
| pending claim | 2분 Strict HttpOnly cookie |
| 모바일 session | Strict HttpOnly cookie, 최대 365일 |
| Push subscription | 활성 모바일 session 소유, 해제·만료 시 전달 대상에서 제외 |

Rust background service는 보호 저장소의 장기 bearer로 `/api/desktop/*`만 호출합니다.
WebView는 장기 credential을 받지 않고 Rust가 발급받은 단기 bearer로
`/api/me/*`를 직접 호출합니다. 브라우저·PWA는 JavaScript가 읽을 수 없는
Strict HttpOnly cookie를 사용합니다.

Spring Security의 Bearer filter와 opaque-token introspection이 세 인증 형식을 공통
`Authentication`으로 변환합니다. 경로별 PC·모바일·WebView 권한과 WebView exact
origin 검사는 `SecurityFilterChain`의 authorization policy에서 처리합니다.

claim과 complete JSON에는 access token, LMS cookie, claim receipt를 포함하지
않습니다. 연결된 모바일이 없는 상태는 정상적인 빈 목록입니다.

## 데스크톱 IPC surface

대시보드 IPC는 운영체제·로컬 앱 경계와 단기 HTTP session bootstrap으로 제한합니다.
공개 정보와 서버 소유 개인 데이터는 IPC proxy 없이 HTTP로 호출합니다.

- HTTP: `bootstrap_desktop_http_session`
- LMS: `open_lms_login`, `refresh_platform_sync`
- 연결: `get_connected_service_status`, `reset_desktop_identity`
- 알림: 로컬 알림함 snapshot·읽음·활성화, 운영체제 테스트 알림
- PC 설정: `get_desktop_settings`, `update_desktop_settings`, `open_log_folder`
- checker 전용: tagged `report_checker_event`

`bootstrap_desktop_http_session`은 호출한 dashboard WebView URL을 Rust에서 직접
검증합니다. `null`, 임의 localhost port, 원격 origin은 허용하지 않습니다.

## 저장 금지 데이터

- LMS access·refresh cookie
- Google SSO cookie 또는 credential
- LMS 페이지 원문 응답
- PC에서 실행할 임의 명령

서버에는 정규화된 출석 snapshot, Jungle Bell session hash, 기기 metadata, 개인
출석·급식 설정, 세탁 watch, Web Push subscription key, pairing 상태, 알림 delivery,
공개 세탁·급식 기록을 저장합니다.

Tauri 사용 통계는 release 빌드에서 사용자가 켠 경우에만 전송합니다. 설치 ID 원문
대신 SHA-256 hash를 쓰고 person profile을 만들지 않습니다. 출석 snapshot, 식단,
세탁 내용은 포함하지 않습니다.

## 스키마와 초기화 정책

- 정식 사용자 데이터가 생기기 전에는 PostgreSQL `schema.sql` 하나만 유지합니다.
- 하위 호환되지 않는 변경은 v2-test volume을 새로 만들고 다시 bootstrap합니다.
- 2026년 8월 13일 cutover에서 공개 세탁·급식 기록만 이전했습니다.
- 사용자, credential, session, 설정, pairing, 알림은 이전하지 않습니다.
- 과거 로컬 설정 파일, `/pair`, `/app`, `/v1` alias는 지원하지 않습니다.
- reset 전 Compose 프로젝트와 PostgreSQL volume이 test 전용인지 확인합니다.
