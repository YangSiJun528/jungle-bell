# 플랫폼 계약 레퍼런스

## 지원 surface

| 기능 | 일반 웹 | 설치 PWA | Tauri PC |
| --- | --- | --- | --- |
| 홈 요약 | 공개 정보만 | 전체 | 전체 |
| 급식·세탁 조회 | 예 | 예 | 예 |
| 출석·D-Day | 로그인 안내 | 서버 snapshot | 로컬 checker snapshot 우선, 서버 snapshot 보완 |
| LMS 주기 조회 | 아니요 | 아니요 | 예 |
| 알림 | 설치 안내 | Web Push | 운영체제 알림 |
| 모바일 연결 | 모바일 QR의 설치 handoff만 | handoff·수동 claim, 연결 완료·해제 | QR·코드 생성, 승인·해제 |
| Jungle Campus | 외부 바로가기 | 외부 바로가기 | 전용 WebView와 상태 |
| PC 서비스 설정 | 아니요 | PC 안내 | 자동 시작·업데이트, 사용 통계, 디버그, 로그 폴더 |

Tauri PC 앱은 macOS와 Windows만 지원합니다. Linux 빌드·배포·CI는 제공하지 않습니다.

PWA surface는 URL 경로가 아니라 `display-mode: standalone` 또는 iOS standalone
상태로 판정합니다. 이는 UI 분기일 뿐 보안 증명이 아닙니다. 서버 권한은 HttpOnly
session 또는 bearer와 사용자·기기 소유권 검사로 결정합니다.

## 서버 런타임

서버는 `core`, `api`, `worker`의 세 Gradle 모듈로 나뉩니다. API와 Worker는 별도
Spring Boot 프로세스로 실행하고 PostgreSQL 접근과 도메인 로직은 Core를 공유합니다.
세 프로세스는 Jungle Bell 운영 Docker Compose로 실행합니다. 실제 호스트는 특정
클라우드 사업자에 종속되지 않습니다.

| 항목 | 계약 |
| --- | --- |
| API | Spring MVC |
| 인증 | Spring Security stateless opaque-token Resource Server |
| 영속성 | Spring Data JDBC, PostgreSQL 17 |
| 수집·알림 | Worker의 Spring Scheduler, API와 별도 JVM |
| 급식 이미지 | PostgreSQL `BYTEA`, SHA-256 immutable URL |
| 정적 자산 | Vite + React 빌드 결과를 API JAR에 포함 |
| 공식 origin | `https://jungle-bell.sijun-yang.com` |
| 외부 ingress | named Cloudflare Tunnel. 실행·저장 계층이 아님 |

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
| 익명 통계 | `GET\|PUT /api/public/usage-preference`, `POST /api/public/usage/ui-opened` |
| PC 등록 | `POST /api/desktop/installations`, `POST /api/desktop/installations/rotate`, `DELETE /api/desktop/installations/current` |
| PC WebView session | `POST /api/desktop/webview-sessions`, `DELETE /api/desktop/webview-sessions/current` |
| PC 동기화 | `POST /api/desktop/heartbeat`, `GET\|PUT /api/desktop/attendance` |
| PC 알림 | `GET /api/desktop/notifications`, ack, test |
| 계정 통계 | `GET /api/me/usage-preference`, `GET\|PUT /api/desktop/usage-preference`, `POST /api/me/usage/ui-opened` |
| 모바일 관리 | `GET /api/me/mobile-sessions`, `DELETE /api/me/mobile-sessions/:id` |
| pairing | PC 생성·상태·승인과 모바일 handoff·claim·complete |
| 브라우저 session | `GET\|DELETE /api/me/session` |
| 공통 계정 정보 | `/api/me` 아래 출석, 설정, 세탁 watch, 알림 |
| PC 전용 계정 관리 | `/api/me` 아래 pairing 승인과 모바일 관리, WebView bearer만 허용 |
| Push | VAPID 공개키, subscription 등록·해제 |

자세한 경로와 인증 방식은 `server/docs/api-reference.md`를 기준으로 합니다.

## 인증과 연결

| 항목 | 계약 |
| --- | --- |
| PC credential | `jbd_…`, 최대 90일, 만료 전 인증된 rotate |
| PC 저장 | Windows Credential Manager. macOS는 앱 전용 mode 0600 파일 |
| PC WebView session | `jbui_…`, 7분 절대 만료, 메모리 전용, 부모 PC session당 하나 |
| WebView origin | release `tauri://localhost`·`http://tauri.localhost`, dev `http://127.0.0.1:5173` |
| pairing | QR 또는 10자리 코드, 10분 유효, PC 명시 승인 |
| install handoff | 10분 Secure·Strict HttpOnly cookie, 권한 없음 |
| pending claim | 10분 Secure·Strict HttpOnly cookie |
| 모바일 session | Strict HttpOnly cookie, 최대 30일 |
| Push subscription | 활성 모바일 session 소유, 해제·만료 시 전달 대상에서 제외 |

Rust background service는 보호 저장소의 장기 bearer로 `/api/desktop/*`만 호출합니다.
WebView는 장기 credential을 받지 않고 Rust가 발급받은 단기 bearer로
`/api/me/*`를 직접 호출합니다. 설치 PWA는 JavaScript가 읽을 수 없는 Strict
HttpOnly cookie를 사용합니다. 일반 웹은 `/api/me/*`를 호출하지 않습니다.

Spring Security의 Bearer filter와 opaque-token introspection이 세 인증 형식을 공통
`Authentication`으로 변환합니다. 경로별 PC·모바일·WebView 권한과 WebView exact
origin 검사는 `SecurityFilterChain`의 authorization policy에서 처리합니다.

유효한 credential이 있는 PC identity 초기화는 인증된
`DELETE /api/desktop/installations/current`가 먼저 성공해야 합니다. 이 요청은 해당
`app_user`를 삭제하여 PC·WebView·모바일 session, Push 구독, 개인 설정과 알림을 한
transaction에서 연쇄 삭제합니다. 서버가 오프라인이거나 삭제를 거부하면 앱은 로컬
credential과 installation ID를 보존하여 모바일 접근이 남은 채로 새 identity를 만들지
않습니다. credential이 이미 누락·만료되어 서버 identity를 증명할 수 없는 복구 경로는
로컬 재등록만 수행하며, 이전 모바일 session은 운영자 확인과 정리가 필요할 수 있습니다.

claim과 complete JSON에는 access token, LMS cookie, claim receipt를 포함하지
않습니다. 연결된 모바일이 없는 상태는 정상적인 빈 목록입니다.

## 사용 통계 계약

### 식별 단위

| 단위 | 생성·저장 | 용도 | 해석 제한 |
| --- | --- | --- | --- |
| 서버 계정 UUID | PC 등록 때 서버가 무작위 UUID 생성 | 인증된 화면 활동·기능 사용의 일일 고유 계정 수 | 활성 서버 계정이지 자연인 수가 아님 |
| PC installation identity | PC 앱이 무작위 UUID v4를 로컬에 생성하고 서버 `desktop_device`에 등록 | PC 등록·session·연결 상태의 설치 단위 | 하드웨어 ID가 아니며 사람 또는 물리 PC와 1:1이 아님 |
| 익명 방문자 | 24시간 HttpOnly cookie를 날짜별 HMAC으로 변환 | 일반 Web·미연결 PWA의 일일 익명 방문 단위 | cookie·브라우저·날짜를 넘어 같은 사람인지 알 수 없음 |

PC installation identity는 서버 계정 등록의 입력이지만 사용 통계 원자료는
installation identity가 아니라 서버 계정 UUID를 저장합니다. 한 사람이 여러 계정이나
설치를 쓸 수 있고, 여러 사람이 하나의 설치를 공유할 수도 있습니다. 서버 계정 수,
installation identity 수, 익명 HMAC 방문자 수를 실제 사람 수로 해석하거나 서로 더하지
않습니다.

### 계정 preference

| 저장값 | 상태 | 수집 gate |
| --- | --- | --- |
| `null` 또는 행 없음 | 선택 대기(`pending`) | 유효 OFF |
| `false` | 명시적 거부 | OFF |
| `true` | 명시적 허용 | ON |

PC 서비스 설정만 계정 preference를 편집합니다. PC 장기 bearer는
`PUT /api/desktop/usage-preference`를 사용합니다. 연결된 PWA에는 같은 계정 gate가
적용되며 상태 조회용 `GET /api/me/usage-preference`만 제공합니다.
`PUT /api/me/usage-preference`는 제공하지 않습니다. 서버는 인증 활동과 기능 원자료를
쓸 때도 preference가 `true`인지 다시 검사합니다.

Desktop 설정 v5의 nullable 값은 다음 규칙으로 정합니다.

| 입력 상태 | v5 결과 | 시작 동작 |
| --- | --- | --- |
| v3 `usageAnalytics=false` | `false` | 기존 명시적 거부 승계 |
| v3 `usageAnalytics=true` | `null` | 과거 기본값이므로 동의로 간주하지 않고 pending/OFF |
| v4 설정 | `null` | 선택을 복원할 수 없어 pending/OFF |
| 설정 파일 없음 + 새 installation identity + 새 등록 상태 | `true` | 완전 신규 설치만 기본 ON |
| 설정 파일 검증·읽기 실패 | 런타임 `false` | 서버 값으로 자동 활성화하지 않고 fail-closed |

일반 Web과 계정에 연결되지 않은 PWA는 계정 preference 대신 브라우저별 익명 opt-out을
사용합니다. 거부는 로컬 저장소와 최대 1년짜리 first-party HttpOnly cookie에 보관하고,
거부할 때 24시간 방문자 cookie를 만료시킵니다. 두 preference는 서로 변경하지 않습니다.

Web·PWA의 자동 UI 열림 reporter는 production 빌드에서만 시작하고, Desktop UI 열림
reporter는 release 빌드에서만 실행합니다. 개발 빌드는 자동 UI 열림 원자료를 보내지
않습니다. 기능 메트릭은 허용된 서버 업무 동작이 성공한 뒤 서버가 내부에서 기록하며
클라이언트가 임의 코드를 제출할 수 없습니다. 서버는 client build 종류를 알 수 없으므로
개발 client가 실제 업무 API를 호출하고 계정 preference가 `true`라면 해당 기능
메트릭은 기록될 수 있습니다.

### 기록·집계·보존

API 요청 thread가 UI 열림 원자료를 PostgreSQL에 동기식으로 기록합니다. `204 No
Content`는 신규 기록, 일일 중복, preference에 따른 생략, 전역 비활성화 중 하나이며
원자료 삽입이나 집계 완료를 보장하지 않습니다. 일시적인 저장 장애는 `Retry-After: 1`을
포함한 `503`이고, UI 열림 클라이언트는 네트워크 오류와 `502`·`503`·`504`만 최대 세
번 시도합니다.

Worker는 ingestion을 수행하지 않습니다. 매시간 원자료를 개인 식별자가 없는 일별
요약으로 재집계하고 보존기간이 지난 행을 삭제합니다.

| 데이터 | 보존기간 |
| --- | --- |
| 익명 화면 활동 원자료 | 2일 |
| 서버 계정별 화면 활동 원자료 | 7일 |
| 서버 계정별 기능 이용 원자료 | 30일 |
| 개인 식별자가 없는 일별 요약 | 730일 |

수집을 끄면 이후 기록부터 중단합니다. 이미 수집된 원자료는 해당 보존기간까지 유지한 뒤
삭제하며, 개인 식별자가 없고 특정 계정의 기여분을 분리할 수 없는 일별 요약은 preference
변경을 이유로 역삭제하지 않습니다. 계정을 삭제하면 인증 원자료는 foreign key cascade로
삭제되고, 아직 원자료 보존 범위인 최근 요약은 다음 Worker 재집계에서 조정될 수 있습니다.
각 기간은 Worker의 삭제 cutoff이며 그 기간 동안 데이터 가용성을 보장하는 SLA가
아닙니다. 세부 테이블과 운영 상태는
[`usage-metrics-reference.md`](../server/docs/usage-metrics-reference.md), 검증 절차는
[`process-usage-metrics-qa.md`](./process-usage-metrics-qa.md)를 기준으로 합니다.

### 휴대폰 설정 흐름

PC가 만드는 QR은 앱 바이너리가 아니라 공식 origin의 설치 안내 링크입니다. 미설치
모바일 브라우저가 링크를 열면 SPA는 QR fragment의 `pairingId`와 일회용 challenge를
React mount 전에 메모리로 옮기고 즉시 `/#/install`로 주소를 치환합니다. 설치 화면은
challenge를 서버에 한 번 전달해 10분짜리 Secure·Strict HttpOnly handoff cookie로
교환합니다. 이 단계에서는 pairing을 claim하거나 개인 API 권한을 발급하지 않습니다.
challenge는 `localStorage`, `sessionStorage`, IndexedDB, 브라우저 history에 기록하지
않습니다. 비모바일 브라우저는 handoff를 시작하지 않고 비밀값을 제거한 뒤 홈으로
이동합니다.

사용자가 PWA를 설치하고 홈 화면 아이콘으로 실행하면 PWA는 handoff cookie로 claim을
시도합니다. Android의 공유 origin 저장소 또는 설치 시 cookie를 전달하는 iOS 환경이면
기기 고유 installation ID로 연결 요청이 자동 생성됩니다. 4자리 확인 번호와 기기명을
PC에서 대조해 승인하기 전에는 모바일 session이나 개인 API 권한을 발급하지 않습니다.
브라우저가 cookie를 전달하지 않거나 handoff가 만료된 환경에서는 설치형 PWA의 10자리
수동 코드 입력으로 복구합니다. 기존 `/#/setup` 링크는 `/#/install`로 이동합니다.

QR 자체가 PWA 설치나 설치 직후 실행을 자동화할 수는 없습니다. iPhone의 **홈 화면에
추가**, Android의 **앱 설치**, 설치한 앱의 첫 실행에는 사용자 조작이 필요합니다.

설치형 PWA가 유효한 cookie로 시작하면 선택형 알림 점검을 표시합니다. PC도 LMS와
서버 session이 준비된 첫 실행에 같은 점검을 표시합니다. 완료와 건너뛰기는
`desktop`과 `pwa`별 화면 상태로만 기억하며 권한이나 서버 session의 근거로 사용하지
않습니다. 점검을 건너뛰어도 알림 센터에서 Push 연결과 테스트를 다시 실행할 수
있습니다.

## 데스크톱 IPC surface

대시보드 IPC는 운영체제·로컬 앱 경계와 단기 HTTP session bootstrap으로 제한합니다.
공개 정보와 서버 소유 개인 데이터는 IPC proxy 없이 HTTP로 호출합니다.

- HTTP: `bootstrap_desktop_http_session`
- LMS: `open_lms_login`, `refresh_platform_sync`
- 연결: `get_connected_service_status`, `reset_desktop_identity`
- 알림: 로컬 알림함 snapshot·읽음·활성화, 운영체제 테스트 알림
- PC 설정: `get_desktop_settings`, `update_desktop_settings`, `open_log_folder`
- checker 전용: tagged `report_checker_event`

checker가 검증된 출석 snapshot을 보고하면 Tauri는 `attendance-snapshot-updated`의
`observed` 이벤트로 데스크톱 UI에 즉시 전달합니다. 서버 업로드가 끝나면 같은 이벤트의
`synced` 변형을 보내 서버 snapshot을 다시 조회합니다. 데스크톱 UI는 아직 동기화되지
않은 로컬 snapshot이 서버 응답보다 새롭고 15분 이내일 때만 로컬 값을 우선합니다.
수동 새로고침도 서버 업로드가 아니라 유효한 로컬 관측을 완료 기준으로 사용합니다.

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

클라이언트 UI 열림 통계는 production Web·PWA 또는 release Desktop에서 해당 범위의
preference가 허용한 경우에만 전송합니다. 인증 원자료에는 서버 계정 UUID를 사용하고,
익명 원자료에는 날짜별 HMAC만 사용합니다. 출석 snapshot, 식단, 세탁 내용과 임의 화면
입력값은 포함하지 않습니다.

## 스키마와 초기화 정책

- 정식 사용자 데이터가 생기기 전에는 PostgreSQL `schema.sql` 하나만 유지합니다.
- 하위 호환되지 않는 변경은 운영 사용자가 생기기 전까지 새 volume에서 다시
  bootstrap합니다.
- 2026년 8월 13일 cutover에서 공개 세탁·급식 기록만 이전했습니다.
- 사용자, credential, session, 설정, pairing, 알림은 이전하지 않습니다.
- Desktop 설정 v3·v4는 사용 통계 migration 규칙에 한해 v5로 변환합니다. 그보다 오래된
  로컬 설정 파일과 `/pair`, `/app`, `/v1` alias는 지원하지 않습니다.
- reset 전 Compose 프로젝트와 PostgreSQL volume이 test 전용인지 확인합니다.
