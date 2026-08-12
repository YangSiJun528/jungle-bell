# 플랫폼 계약 레퍼런스

## 지원 surface

| 기능 | 일반 웹 | 설치 PWA | Tauri PC |
| --- | --- | --- | --- |
| 오늘 홈 요약 | 공개 정보만 | 전체 | 전체 |
| 급식·세탁 조회 | 예 | 예 | 예 |
| 출석 조회 | 설치 안내 | 서버 snapshot | 로컬·서버 snapshot |
| LMS 주기 조회 | 아니요 | 아니요 | 예 |
| 알림 | 설치 안내 | Web Push | 운영체제 알림 |
| 모바일 연결 | 아니요 | 수동 코드·해제 | QR·코드 생성, 승인·해제 |
| Jungle Campus | 외부 바로가기 | 외부 바로가기 | 전용 WebView와 상태 |
| 서비스 설정 | 아니요 | PC에서 설정 안내 | 자동 시작·업데이트, 사용 통계, 디버그, 로그 폴더 |

App Worker는 HTTP API와 대시보드·PWA·Markdown 블로그 정적 자산만 제공합니다.
주기 실행, 공개 데이터 수집, 알림 계획, housekeeping, Web Push 전송은 OCI Jobs가
담당합니다. App Worker에는 Cron Trigger와 VAPID private key를 설정하지 않습니다.

## 서버 런타임 경계

| 항목 | App Worker | OCI Jobs |
| --- | --- | --- |
| 실행 조건 | `fetch` 요청 | Supercronic 매분 실행, `flock` 중복 방지 |
| D1 | 고정 `DB` binding | 환경별 고정 `/internal/jobs/d1` gateway |
| R2 | 고정 `DATA_BUCKET` binding | 환경별 고정 `/internal/jobs/r2` gateway |
| Web Push | 공개키 제공·구독 저장 | VAPID key pair로 pending delivery 전송 |
| 금지 항목 | Cron Trigger, VAPID private key | D1 관리 자격 증명, database 선택값 |

Gateway는 App Worker 공개 origin의 `/internal/jobs/d1`, `/internal/jobs/r2`에 있고
32자 이상의 `JOBS_D1_GATEWAY_SECRET` bearer를 요구합니다. 요청자가 D1이나 R2
대상을 지정할 수 없으며 Worker의 고정 `DB`, `DATA_BUCKET` binding만 사용합니다.
OCI는 같은 secret을 `JOBS_D1_GATEWAY_SECRET_FILE`로 mount합니다.

Production은 production Worker gateway만, v2-test는 test Worker gateway만 사용할
수 있습니다. 각 Worker의 R2 binding이 환경별 bucket을 고정합니다. Runtime은
`JUNGLE_BELL_ENVIRONMENT`, `JOBS_D1_GATEWAY_URL` 조합이 고정 대상과 다르면 시작을
거부합니다. Gateway secret과 VAPID key pair는 환경 간에 재사용하지 않습니다.

PWA surface는 URL 경로가 아니라 `display-mode: standalone` 또는 iOS standalone
상태로 판정합니다. URL pathname·query·fragment로 개인 기능을 활성화하지
않습니다.

이 판정은 UI surface 분기이며 보안 증명이나 cryptographic attestation이
아닙니다. 일반 웹 UI는 개인 메뉴를 숨기고 설치를 안내하지만, 동일 origin의
browser session이 반드시 설치 PWA에서만 사용됐다고 서버가 보장할 수는 없습니다.
서버 권한은 surface 신호가 아니라 Strict HttpOnly session과 사용자·기기 소유권
검사로 결정합니다.

## HTTP surface

사용자용 새 API는 `/api` 계약만 제공합니다. 이전 `/v1` 경로와 단수·복수 alias는
지원하지 않습니다. `/internal/jobs/d1`, `/internal/jobs/r2`는 OCI Jobs 전용이며 사용자 API가 아닙니다.

| 영역 | endpoint |
| --- | --- |
| 상태 | `GET /api/health`, `GET /api/public/status` |
| 공개 세탁 | `GET /api/public/laundry`, `/head`, `/at`, `/minutes/:minute`, `/versions/:sha`, `/events` |
| 공개 급식 | `GET /api/public/meals`, `GET /api/public/meals/history` |
| 공개 자산 | `GET /api/public/assets/:asset` |
| PC 등록 | `POST /api/desktop/installations`, `POST /api/desktop/installations/rotate` |
| PC 동기화 | `POST /api/desktop/heartbeat`, `GET\|PUT /api/desktop/attendance` |
| PC 알림 | `GET /api/desktop/notifications`, `POST /api/desktop/notifications/:id/ack`, `POST /api/desktop/notifications/test` |
| 모바일 관리 | `GET /api/desktop/mobile-sessions`, `DELETE /api/desktop/mobile-sessions/:id` |
| pairing | `POST /api/pairings`, `GET /api/pairings/:id`, claim·approve·complete 하위 endpoint |
| 모바일 session | `GET\|DELETE /api/mobile/session` |
| 모바일 개인 정보 | `GET /api/mobile/attendance`, `GET /api/mobile/notifications`, `POST /api/mobile/notifications/test` |
| 공통 개인 설정 | desktop/mobile 각각 기존 `GET\|PUT attendance/preferences`, 확장 `GET\|PUT v2/attendance/preferences`, `GET\|PUT meal-preferences` |
| 세탁 개인 기능 | desktop/mobile 각각 laundry watch·queue `GET\|POST\|DELETE` |
| Push | `GET /api/push/vapid-public-key`, `PUT /api/push/subscriptions`, `DELETE /api/push/subscriptions/:id` |
| OCI 내부 | `POST /internal/jobs/d1`, `GET\|HEAD\|PUT /internal/jobs/r2?key=...` |

desktop endpoint는 `Authorization: Bearer jbd_…`를 사용합니다. 모바일·PWA endpoint는
JavaScript가 읽을 수 없는 Strict HttpOnly cookie를 사용하며 브라우저 요청은
`credentials: include`와 `cache: no-store`로 전송합니다.

## 연결과 session

| 항목 | 계약 |
| --- | --- |
| PC credential | 서버 발급 후 최대 90일, 만료 7일 전부터 인증된 rotate |
| PC 저장 | 앱 전용 디렉터리의 일반 파일, keychain 미사용. Unix는 `0600` 검증, Windows는 상속 ACL 사용 |
| pairing | QR 또는 10자리 코드, 2분 유효, PC의 명시적 승인 필요 |
| pending claim | claim receipt는 2분 Strict HttpOnly cookie에만 저장 |
| 브라우저 임시 상태 | `pairingId`, `claimId`, 생성 시각만 `sessionStorage`에 보관 |
| 모바일 session | 승인 시 Strict HttpOnly cookie 발급, 최대 365일 |
| Push subscription | 활성 모바일 session 소유이며 해제·만료 시 전달 대상에서 제외 |

claim과 complete JSON에는 access token, bearer, LMS cookie, claim receipt가 포함되지
않습니다. 현재 버전은 `/pair`와 `/app` 리다이렉트 entry도 제공하지 않습니다.

## 데스크톱 IPC surface

대시보드가 사용하는 IPC는 목적별 current-only command로 제한합니다.

- LMS: `open_lms_login`, `report_checker_event`, `get_remote_attendance_snapshot`
- 연결: `get_connected_service_status`, identity reset, pairing·모바일 session 관리
- 개인 기능: 출석·급식 설정, 세탁 watch·queue 조회와 변경
- 생활 정보: `get_dashboard_campus_data`, `refresh_campus_data`
- 홈: `get_dashboard_home_overview`
- 알림: 알림함 snapshot·활성화·테스트
- PC 설정: `get_desktop_settings`, `update_desktop_settings`의 `autoStart`,
  `autoUpdate`, `usageAnalytics`, `debugMode`와 경로 입력을 받지 않는
  `open_log_folder`

원격 checker WebView는 tagged `report_checker_event` 하나만 호출할 수 있습니다.
일반 대시보드 IPC와 임의 명령 실행 권한은 갖지 않습니다.

## 저장 금지 데이터

- LMS access cookie
- LMS refresh cookie
- Google SSO cookie 또는 credential
- LMS 페이지 원문 응답
- PC에서 실행할 임의 명령

서버에는 정규화된 출석 snapshot, Jungle Bell session hash, 설치·연결 기기 metadata,
개인 출석·급식 설정, 세탁 watch·자율 대기열, Web Push subscription key, pairing
상태와 알림 본문·delivery 이력을 저장합니다. LMS cookie·token과 LMS 페이지 원문은
저장하지 않습니다.

Tauri의 사용 통계는 release 빌드에서 사용자가 켠 경우에만 PostHog capture endpoint로
전송합니다. 로컬 설치 ID 원문 대신 SHA-256 해시를 stable distinct ID로 사용하고,
person profile 생성을 끕니다. 허용 항목은 앱 실행, 서비스 설정 변경 이벤트, 앱 버전,
운영체제뿐입니다. LMS 계정·출석 snapshot·식단·세탁 내용은 포함하지 않습니다.
사용자가 통계를 끄면 opt-out 변경 이벤트를 마지막으로 전송한 뒤 이후 capture를
중단합니다. 이 설정은 서버 계정이 아니라 각 PC의 `desktop-settings.json`에
저장합니다.

## 호환성과 초기화

- `database/schema.sql`은 신규 D1 bootstrap에만 사용합니다. 기존 D1 변경은
  `database/migrations/`의 검토된 비파괴 SQL을 백업 후 한 번만 적용합니다.
- 출석 알림 확장 배포 중 기존 클라이언트는 4필드 attendance preference 경로를
  계속 사용하고, 신규 클라이언트만 명시적인 v2 경로를 사용합니다.
- 과거 desktop credential, 모바일 cookie, pairing은 재사용하지 않습니다.
- 과거 로컬 설정 파일을 읽거나 자동 변환하지 않습니다.
- 과거 `/pair`, `/app`, `/v1` URL entry와 alias를 제공하지 않습니다.
- test Worker의 `DB`·`DATA_BUCKET` binding은 운영 리소스와 분리해야 합니다.
- OCI production/test는 반대 환경의 gateway URL, R2 bucket, secret을 사용할 수 없습니다.
- reset 명령은 이름과 ID가 명시적으로 test 전용인지 확인하기 전에는 실행하지
  않습니다.
