# 상태 관리 레퍼런스

## 상태 소유권

| 상태 | 기준 저장소 | 화면 projection | 동기화 경계 |
| --- | --- | --- | --- |
| LMS cookie·SSO session | 전용 `checker` WebView profile | PC의 LMS 연결 상태 | same-origin collector → tagged checker IPC |
| checker·출석 runtime | Rust `AppState` | 트레이 아이콘·서버 출석 snapshot | checker IPC·desktop HTTP API |
| 서버용 PC credential | Windows Credential Manager 또는 mode 0600 앱 파일 + `RemoteSyncService` | PC 연결 상태 | 장기 desktop HTTP API |
| WebView HTTP session | React 메모리 + PostgreSQL session hash | PC의 서버 소유 개인 화면 | bootstrap IPC → `/api/me` |
| PC 로컬 서비스 설정 | Rust `DesktopSettingsService` | LMS 기수 선택·자동 시작·업데이트·디버그 | exact get/update IPC |
| 계정 사용 통계 preference | nullable PC 로컬 설정 + PostgreSQL `usage_preference` | PC 사용 통계 스위치·연결 PWA 수집 gate | PC IPC → desktop GET/PUT, PWA에는 같은 서버 gate 적용 |
| 익명 사용 통계 opt-out | 브라우저 `localStorage` + first-party HttpOnly cookie | 개인정보 화면의 익명 방문 통계 스위치 | public usage preference GET/PUT |
| 공개 세탁·급식 cache | React Query | 공통 SPA 생활 정보 | public HTTP API |
| PC 알림함 | `NotificationInboxService` | 대시보드 unread projection | snapshot command + inbox event |
| 연결·개인 설정·알림 delivery | PostgreSQL | 공통 SPA 개인 화면 | short WebView bearer 또는 HttpOnly cookie로 `/api/me` 호출 |
| 공개 수집 기록·자산 | PostgreSQL | 공개 웹·PC·PWA 생활 정보 | public `/api` |
| PWA Push subscription | 브라우저 PushManager + PostgreSQL | PWA 운영체제 알림 | service worker push event |

LMS credential은 첫 번째 행 밖으로 이동하지 않습니다. 서버와 일반 WebView에는
정규화한 출석 snapshot과 Jungle Bell 자체 session만 전달합니다.

## 브라우저 로컬 상태

| key | 저장소 | 목적 | 보안 성격 |
| --- | --- | --- | --- |
| `jungle-bell:mobile-installation-id` | `localStorage` | 재연결 시 같은 모바일 설치 식별자 사용 | 비밀 아님 |
| `jungle-bell:pending-mobile-pairing` | `sessionStorage` | 10분 이내 pairing poll 복구 | ID·생성 시각만, 권한 없음 |
| `jungle-bell:seen-mobile-notifications` | `localStorage` | 이 브라우저의 안 본 알림 표시 | 화면 projection |
| `jungle-bell:anonymous-usage:v1` | `localStorage` | 익명 통계 거부를 서버 cookie와 함께 fail-closed로 유지 | 브라우저별 opt-out 보조 상태 |
| `jungle-bell:notification-onboarding:desktop:v1` | `localStorage` | PC 알림 점검 완료·건너뛰기 기억 | 화면 전용 |
| `jungle-bell:notification-onboarding:pwa:v1` | `localStorage` | 설치형 PWA 알림 점검 완료·건너뛰기 기억 | 화면 전용 |
| install nudge dismissal | `sessionStorage` | 현재 탭에서 안내창 재표시 방지 | 화면 전용 |

모바일 session token, 설치 handoff, pending claim receipt는 브라우저 저장 API에
기록하지 않습니다. 서버가 발급한 Secure·Strict HttpOnly cookie가 유일한 기준입니다.
단기 desktop-ui token도 `localStorage`, `sessionStorage`, IndexedDB, React Query
cache에 기록하지 않고 한 API client 인스턴스의 메모리에서만 유지합니다.

익명 방문 통계 허용 상태의 서버 기준은 최대 1년짜리 `jb_usage_opt_out` 또는
`__Host-jb_usage_opt_out` HttpOnly cookie입니다. 로컬 저장소의 거부값은 cookie 조회가
실패하거나 갱신 중일 때도 전송을 막는 보조 gate입니다. 24시간 방문자 cookie
`jb_usage` 또는 `__Host-jb_usage`는 통계 거부 시 만료합니다. 이 상태는 서버 계정의
`usage_preference`와 연결하지 않습니다.

QR fragment의 `pairingId`와 일회용 challenge는 React mount 전 모듈 메모리로만
옮기고 주소에서 즉시 제거합니다. 미설치 모바일 브라우저는 challenge를 10분짜리
HttpOnly handoff cookie로 교환한 뒤 설치 안내만 표시합니다. 설치형 PWA가 해당 cookie로
claim을 시작한 뒤에만 `sessionStorage`에 poll 복구용 식별자와 생성 시각을 남깁니다.
challenge나 claim receipt는 저장하지 않습니다.

## 런타임별 상태

### 일반 웹과 설치 PWA

- 같은 SPA와 route를 사용하되 일반 웹은 공개 API만 호출합니다.
- `display-mode: standalone` 또는 iOS standalone으로 실행한 PWA만 HttpOnly session
  cookie로 서버 출석 snapshot과 개인 설정을 읽고 변경합니다.
- 일반 Web과 연결되지 않은 PWA의 UI 열림은 브라우저별 익명 opt-out을 따릅니다.
  연결된 PWA의 UI 열림과 기능 이용은 서버 계정 preference가 `true`일 때만 기록합니다.
- LMS를 직접 조회하거나 주기적 background fetch로 PC 역할을 대신하지 않습니다.
- 설치 PWA의 Push payload는 만료 시각과 허용된 대시보드 경로를 검증한 뒤 표시합니다.

### Tauri PC

- 하나의 `checker` WebView가 LMS session을 유지하고 출석을 주기적으로 확인합니다.
- Rust가 정규화한 snapshot만 서버로 올리고 heartbeat와 알림 poll을 수행합니다.
- 대시보드는 공개 세탁·급식과 서버 출석·설정·연결 데이터를 직접 HTTP로 조회합니다.
- 장기 desktop credential은 WebView에 노출하지 않고, Rust는 exact origin에 묶인
  7분짜리 desktop-ui session만 bootstrap합니다.
- 대시보드는 로컬 앱 URL만 사용합니다. 트레이 아이콘을 누르면 별도 목록 창 없이
  대시보드 홈을 엽니다.
- 자동 시작·자동 업데이트·디버그 설정은 PC 로컬에만 적용합니다. 계정 사용 통계는
  nullable 로컬 값을 서버 계정 preference에 동기화하며 PC 서비스 설정만 편집합니다.
  `null`은 pending이지만 유효 OFF이고 `false`는 OFF, `true`는 ON입니다.
- Web·PWA production 빌드와 Desktop release 빌드만 UI 열림 전송을 시작합니다.
  로그 폴더는 경로 입력 없이 앱 전용 위치만 엽니다.

## 불변 조건

- 화면 event는 기준 상태가 아닙니다. 창을 다시 열면 snapshot command로 수렴해야
  합니다.
- private HTTP 응답과 Tauri IPC DTO는 unknown field와 호환 alias를 거부합니다.
- service worker는 `/api/public/` 이외의 `/api/` 응답을 cache하지 않습니다.
- 사용 통계에서 서버 계정 UUID, PC installation identity, 날짜별 익명 HMAC은 서로 다른
  운영 단위이며 어느 것도 실제 사람 수로 간주하지 않습니다.
- 계정 preference가 `null` 또는 `false`이면 PC·연결 PWA의 인증 원자료를 기록하지
  않습니다. 익명 opt-out은 일반 Web·미연결 PWA에만 적용합니다.
- 하나의 notification event는 대상별 delivery로 분리되며 활성 PC와 PWA가 각자
  acknowledgement·재시도 상태를 가집니다.
- 데스크톱 inbox는 알림 delivery만 운반하며 PC 원격 명령 queue로 사용하지
  않습니다.
- 로컬 화면 상태를 서버 권한이나 출석 사실의 근거로 사용하지 않습니다.

## 구현 위치

| 계약 | 구현 |
| --- | --- |
| 공통 플랫폼 계약 | [`contracts.ts`](../frontend/src/platform/contracts.ts) |
| Web·PWA 어댑터 | [`web`](../frontend/src/platform/web), [`pwa`](../frontend/src/platform/pwa) |
| Tauri UI 어댑터 | [`tauri`](../frontend/src/platform/tauri) |
| 브라우저 HTTP adapter | [`dashboard-api.ts`](../frontend/src/api/dashboard-api.ts), [`personal-api.ts`](../frontend/src/api/personal-api.ts) |
| 대시보드 홈 projection | [`home-view-model.ts`](../frontend/src/features/home/home-view-model.ts), [`dday-progress.ts`](../frontend/src/domain/attendance/dday-progress.ts) |
| pairing 임시 상태 | [`pending-pairing.ts`](../frontend/src/features/connections/lib/pending-pairing.ts) |
| PWA cache·Push | [`sw.js`](../frontend/src/platform/pwa/service-worker/sw.js) |
| 데스크톱 연결 service | [`remote_sync.rs`](../desktop/src/remote_sync.rs) |
| 사용 통계 설정·전송 | [`config.rs`](../desktop/src/config.rs), [`usage-reporting.ts`](../frontend/src/platform/web/usage-reporting.ts), [`usage-preference.ts`](../frontend/src/platform/web/usage-preference.ts) |
| 사용 통계 서버 상태 | [`UsageRecorder.kt`](../server/core/src/main/kotlin/app/junglebell/server/domain/usage/UsageRecorder.kt), [`UsageAggregationService.kt`](../server/core/src/main/kotlin/app/junglebell/server/domain/usage/UsageAggregationService.kt) |
| checker WebView | [`checker.rs`](../desktop/src/checker.rs), [`checker.ts`](../frontend/src/platform/tauri/checker/checker.ts) |
| Rust 기준 상태 | [`state.rs`](../desktop/src/state.rs), [`desktop_settings.rs`](../desktop/src/desktop_settings.rs) |
