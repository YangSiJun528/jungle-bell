# 상태 관리 레퍼런스

## 상태 소유권

| 상태 | 기준 저장소 | 화면 projection | 동기화 경계 |
| --- | --- | --- | --- |
| LMS cookie·SSO session | 전용 `checker` WebView profile | PC의 LMS 연결 상태 | same-origin collector → tagged checker IPC |
| checker·출석 runtime | Rust `AppState` | 대시보드 홈·트레이 아이콘 출석 상태 | Tauri command·내부 event |
| 서버용 PC credential | 앱 전용 credential 파일 + `RemoteSyncService` | PC 연결 상태 | canonical desktop HTTP API |
| 자동 실행 설정 | Rust `DesktopSettingsService` | 대시보드의 `autoStart` toggle | exact get/update IPC |
| 공개 세탁·급식 cache | `CampusService` | 대시보드 생활 정보 | snapshot command + campus event |
| PC 알림함 | `NotificationInboxService` | 대시보드 unread projection | snapshot command + inbox event |
| 연결·개인 설정·알림 delivery | 서버 D1 | PC/PWA 개인 화면 | desktop bearer 또는 mobile HttpOnly cookie |
| 공개 수집 원본·자산 | 서버 R2 | 공개 웹·PC·PWA 생활 정보 | public `/api` |
| PWA Push subscription | 브라우저 PushManager + 서버 D1 | PWA 운영체제 알림 | service worker push event |

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

## 런타임별 상태

### 일반 웹

- 공개 세탁·급식 snapshot만 조회합니다.
- 출석, 개인 설정, 알림함, Push API를 조회하거나 변경하지 않습니다.
- 설치 안내를 닫았는지만 현재 browser session에 남깁니다.

### 설치 PWA

- `display-mode: standalone` 또는 iOS standalone 신호로만 판정합니다.
- 서버 출석 snapshot과 개인 설정을 읽고 변경합니다.
- LMS를 직접 조회하거나 주기적 background fetch로 PC 역할을 대신하지 않습니다.
- Push payload는 만료 시각과 허용된 대시보드 경로를 검증한 뒤 표시합니다.

### Tauri PC

- 하나의 `checker` WebView가 LMS session을 유지하고 출석을 주기적으로 확인합니다.
- Rust가 정규화한 snapshot만 서버로 올리고 heartbeat와 알림 poll을 수행합니다.
- 대시보드·이미지 뷰어는 로컬 앱 URL만 사용합니다. 트레이 아이콘을 누르면 별도
  목록 창 없이 대시보드 홈을 엽니다.
- 사용자 설정은 현재 버전의 `autoStart` 한 필드만 노출합니다.

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
| 런타임 판정 | [`dashboard-runtime.ts`](../src/dashboard-runtime.ts) |
| 브라우저 API adapter | [`dashboard-api.ts`](../src/dashboard-api.ts), [`dashboard-personal-api.ts`](../src/dashboard-personal-api.ts) |
| 대시보드 홈 projection | [`dashboard-home.ts`](../src/dashboard-home.ts), [`dday-progress.ts`](../src/dday-progress.ts) |
| pairing 임시 상태 | [`dashboard-pending-pairing.ts`](../src/dashboard-pending-pairing.ts) |
| PWA cache·Push | [`sw.js`](../src/public/sw.js) |
| 데스크톱 연결 service | [`remote_sync.rs`](../src-tauri/src/remote_sync.rs) |
| checker WebView | [`checker.rs`](../src-tauri/src/checker.rs), [`checker.ts`](../src/injected/checker.ts) |
| Rust 기준 상태 | [`state.rs`](../src-tauri/src/state.rs), [`desktop_settings.rs`](../src-tauri/src/desktop_settings.rs) |
