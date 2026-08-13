# 상태 관리 레퍼런스

## 상태 소유권

| 상태 | 기준 저장소 | 화면 projection | 동기화 경계 |
| --- | --- | --- | --- |
| LMS cookie·SSO session | 전용 `checker` WebView profile | PC의 LMS 연결 상태 | same-origin collector → tagged checker IPC |
| checker·출석 runtime | Rust `AppState` | 트레이 아이콘·서버 출석 snapshot | checker IPC·desktop HTTP API |
| 서버용 PC credential | Windows Credential Manager 또는 mode 0600 앱 파일 + `RemoteSyncService` | PC 연결 상태 | 장기 desktop HTTP API |
| WebView HTTP session | React 메모리 + PostgreSQL session hash | PC의 서버 소유 개인 화면 | bootstrap IPC → `/api/me` |
| PC 서비스 설정 | Rust `DesktopSettingsService` | LMS 기수 선택·자동 시작·업데이트·사용 통계·디버그 | exact get/update IPC |
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
| `jungle-bell:pending-mobile-pairing` | `sessionStorage` | 2분 이내 pairing poll 복구 | ID·생성 시각만, 권한 없음 |
| `jungle-bell:seen-mobile-notifications` | `localStorage` | 이 브라우저의 안 본 알림 표시 | 화면 projection |
| install nudge dismissal | `sessionStorage` | 현재 탭에서 안내창 재표시 방지 | 화면 전용 |

모바일 session token과 pending claim receipt는 브라우저 저장 API에 기록하지
않습니다. 서버가 발급한 Strict HttpOnly cookie가 유일한 인증 기준입니다.
단기 desktop-ui token도 `localStorage`, `sessionStorage`, IndexedDB, React Query
cache에 기록하지 않고 한 API client 인스턴스의 메모리에서만 유지합니다.

## 런타임별 상태

### 브라우저와 설치 PWA

- 설치 여부와 관계없이 같은 SPA, route, 계정 API를 사용합니다.
- HttpOnly session cookie로 서버 출석 snapshot과 개인 설정을 읽고 변경합니다.
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
- 자동 시작·자동 업데이트·사용 통계·디버그 설정은 PC 로컬에 저장하고, 로그 폴더는
  경로 입력 없이 앱 전용 위치만 엽니다.

## 불변 조건

- 화면 event는 기준 상태가 아닙니다. 창을 다시 열면 snapshot command로 수렴해야
  합니다.
- private HTTP 응답과 Tauri IPC DTO는 unknown field와 호환 alias를 거부합니다.
- service worker는 `/api/public/` 이외의 `/api/` 응답을 cache하지 않습니다.
- 하나의 notification event는 대상별 delivery로 분리되며 활성 PC와 PWA가 각자
  acknowledgement·재시도 상태를 가집니다.
- 데스크톱 inbox는 알림 delivery만 운반하며 PC 원격 명령 queue로 사용하지
  않습니다.
- 로컬 화면 상태를 서버 권한이나 출석 사실의 근거로 사용하지 않습니다.

## 구현 위치

| 계약 | 구현 |
| --- | --- |
| 런타임 판정과 기능 어댑터 | [`runtime.ts`](../src/app/runtime.ts), [`platform-adapter.ts`](../src/platform/platform-adapter.ts) |
| 브라우저 HTTP·native adapter | [`dashboard-api.ts`](../src/api/dashboard-api.ts), [`personal-api.ts`](../src/api/personal-api.ts) |
| 대시보드 홈 projection | [`home-view-model.ts`](../src/features/home/home-view-model.ts), [`dday-progress.ts`](../src/domain/attendance/dday-progress.ts) |
| pairing 임시 상태 | [`pending-pairing.ts`](../src/features/connections/lib/pending-pairing.ts) |
| PWA cache·Push | [`sw.js`](../src/service-worker/sw.js) |
| 데스크톱 연결 service | [`remote_sync.rs`](../src-tauri/src/remote_sync.rs) |
| checker WebView | [`checker.rs`](../src-tauri/src/checker.rs), [`checker.ts`](../src/injected/checker.ts) |
| Rust 기준 상태 | [`state.rs`](../src-tauri/src/state.rs), [`desktop_settings.rs`](../src-tauri/src/desktop_settings.rs) |
