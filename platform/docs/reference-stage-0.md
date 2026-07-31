# Jungle Bell 구현·운영 참조

이 문서는 현재 플랫폼의 surface, 인증 경계, 주요 시간값, 환경 변수,
검증 명령을 요약합니다. 설계 이유는
[아키텍처 설명](explanation-architecture.md), 실행 절차는 각
`guide_*.md` 문서를 참고하십시오.

## 지원 topology

| 항목 | 지원 값 |
| --- | --- |
| 사용자 규모 | 최대 200명 목표 |
| application | OCI VM 1대, app container 1개, Node.js process 1개 |
| proxy | host Caddy 1개, app은 `127.0.0.1:8787`에만 bind |
| 저장소 | VM 로컬 영속 디스크의 SQLite |
| SQLite | WAL, `synchronous=FULL`, foreign key, 5초 `busy_timeout`, 1,000-page auto-checkpoint |
| backup | `better-sqlite3` online backup과 생성본 `integrity_check` |
| network | same-origin HTTPS; 개발만 loopback HTTP |
| offline | 미지원 |

다중 process·container replica·VM, NFS·공유 volume은 지원하지 않습니다.

## Surface와 기능

| surface | 경로·인증 | 기능 |
| --- | --- | --- |
| 공개 웹 | `/`, 인증 없음 | 실제 급식·세탁과 freshness 조회 |
| Tauri | server React 앱 + desktop app session | LMS 연결, 출석, 생활 설정, 모바일 관리, 네이티브 알림 |
| 모바일 연결 | `/pair` 또는 `/app`의 수동 코드 | 2분 QR proof 또는 10자리 코드 claim |
| 모바일 PWA | `/app`, mobile session | 출석, 생활 설정, 자율 대기열, Web Push, self logout |

React route와 component 분기는 인증 경계가 아닙니다. 개인 API는
desktop 또는 mobile session을 서버에서 검사합니다.

## 사용자·자격 증명 경계

| 값 | 원문 위치 | 서버 저장 |
| --- | --- | --- |
| LMS `access_token` | Tauri LMS WebView | onboarding `/api/v2/me` 호출 중 메모리만 |
| LMS `refresh_token` | Tauri LMS WebView | 없음; 서버 전송 금지 |
| LMS immutable ID | LMS `/api/v2/me` 응답 | domain-separated HMAC-SHA-256 |
| onboarding subject binding | Tauri와 서버가 각각 계산 | installation ID와 LMS ID의 domain-separated SHA-256; 원문 ID 전송 없음 |
| 로컬 account binding | Tauri app data | 없음; installation별 SHA-256 digest |
| desktop app session | main WebView HttpOnly cookie | SHA-256 token hash |
| mobile session | PWA HttpOnly cookie | SHA-256 token hash |
| pairing proof·수동 코드 | QR fragment 또는 사용자 입력 | hash와 2분 transport 상태 |
| Push subscription | browser | endpoint, 공개 암호화 material, 소유 기기 |

Production desktop cookie 이름은 `__Secure-jb_app`이고 public host의
Domain, `Secure`, `HttpOnly`, `SameSite=Strict`, path `/`를 사용합니다.
loopback 개발에서는 `jb_app`입니다. 수명은 90일입니다.

Mobile cookie 이름은 `jb_device`이고 host-only, `HttpOnly`,
`SameSite=Strict`, production `Secure`, path `/`입니다. session 수명은
30일입니다. DB에는 두 session token의 원문이 저장되지 않습니다.

서버 onboarding은 다음 모두를 만족하는 `access_token` 하나만
허용합니다.

- 이름 `access_token`
- 정확한 `jungle-lms.krafton.com` domain
- 정확한 cookie path·Secure·HttpOnly 조건
- 유효한 cookie 문자와 크기

서버는 이 cookie로 `/api/v2/me`만 호출해 `id`를 확인하고 즉시
폐기합니다. email fallback, 서버 refresh, LMS credential table은
없습니다.

## 다중 PC 규칙

- PC마다 installation UUID, desktop device, desktop app session이
  독립적입니다.
- 같은 LMS `id`를 검증하면 identity HMAC이 같으므로 같은 내부 사용자
  UUID에 연결됩니다.
- 추가 PC 등록에 기존 PC 승인이나 모바일 pairing을 사용하지 않습니다.
- Tauri app data에는 LMS ID 원문 대신 installation UUID와 subject의
  domain-separated SHA-256 digest만 저장합니다.
- 앱 재시작 뒤 유효한 app session과 로컬 subject binding이 있으면
  heartbeat는 LMS 상태를 `unknown` 또는 `login-required`로 보고할 수
  있습니다. 현재 LMS subject가 digest와 일치하고 서버 재검증이 끝나기
  전에는 원격 dashboard, `connected` 보고, 출석 snapshot 업로드를
  허용하지 않습니다. desktop inbox에서는 generic `login-required`만
  표시·ACK하고, 급식·세탁·출석 delivery는 ACK하지 않아 lease 뒤 다시
  전달되게 합니다. 미검증 inbox claim은 재시작 시 1회와
  `login-required` 상태로 새로 전환될 때 1회만 허용해 deferred
  delivery의 재claim 횟수가 소진되지 않게 합니다.
- 여러 PC snapshot 중 `collectedAt`이 가장 최신인 값만 채택합니다.
- 미래로 5분을 초과하는 수집 시각은 거부합니다.

## 주요 시간값

| 항목 | 현재 값 |
| --- | --- |
| Tauri 출석 수집 | 시작·navigation 때 즉시, 이후 5분; 정확한 `학습 시작` 클릭 뒤 최대 5회 확인 |
| Tauri heartbeat | 최초 5초 뒤, 이후 30초 |
| Tauri desktop inbox | 최초 5초 뒤, 이후 15초 |
| LMS agent HTTP timeout | 12초 |
| 웹 API request timeout | 15초 |
| desktop online 판정 | 마지막 heartbeat 또는 inbox poll 5분 이내 |
| 출석 fresh 판정 | 수집 15분 이내 |
| desktop app session | 90일 |
| mobile session | 30일 |
| QR·수동 코드·claim transport | 2분 |
| manual code | Crockford Base32 10자리, 일회용, 코드별 제한 |
| 세탁 대기열 claim | 5분; 사용 가능 유지 시 다음 선두로 이동 |
| campus worker wake | 1초 |
| 세탁 polling / stale | 30초 / 2분 |
| 급식 polling / stale | 5분 / 15분 |
| campus 실패 backoff | source별 기본 주기의 지수 backoff, 최대 30분 |
| notification worker wake | 1초 |
| desktop notification ack lease | 2분 |
| terminal notification·session·세탁 상태 보존 | 30일 |
| 만료 pairing artifact 보존 | 7일 |
| retention prune | 시작 직후, 이후 최대 1시간 간격 |

`node-cron`의 wake 자체는 durable하지 않습니다. campus의 next poll과
notification due·lease·retry는 SQLite에 저장됩니다.

## 출석 알림 규칙

출석 알림 기본값은 꺼짐입니다. 사용자가 전체 알림과 오전·오후 phase를
켜야 합니다.

- cohort가 `active`이고 snapshot이 15분 이내일 때만 판단
- 오전 미완료 또는 오전 완료·오후 미완료 상태만 대상
- KST 마감 전 60분·15분·5분 구간과 마감 직후 구간별 source event
- 사용자·날짜·phase·구간별 dedupe
- 이미 완료된 phase, 다른 날짜, stale snapshot에는 생성하지 않음

PC가 꺼져 있으면 서버가 LMS를 대신 조회하지 않습니다. 마지막 snapshot
이 오래되면 알림을 추측해 만들지 않습니다.

## 급식·세탁 규칙

급식은 전체 enable과 조식·중식·석식 선택을 저장합니다. 새 게시물의
service date, meal, `contentSha`를 기준으로 사용자별 dedupe합니다.

세탁 watch 입력은 machine, washer·dryer, 선택적 session, 종료 전 분,
사용 가능 알림 여부입니다. 한 사용자에게 active watch를 최대 64개
허용합니다.

- 동작 watch: 종료 전, 완료, 오류·일시 정지, 사용 가능 전환
- availability watch: 다음 사용 가능 전환
- terminal 조건 처리 뒤 watch 자동 완료
- 같은 조건의 active watch 중복 금지

자율 대기열은 machine 선택 또는 기기 종류 전체에 참여할 수 있습니다.
순서는 서버에 공유되지만 실제 예약·사용 권한이 아닙니다. 사용 가능
상태에서 선두 한 명만 5분 claim해 알림을 dedupe하며, 사용 가능 상태가
유지되면 만료 뒤 다음 선두로 넘어갑니다. 물리 기기를 잠그지 않습니다.
개인 조회에는 현재 waiting 순번과 최근 24시간의 claimed·expired 결과
최대 8건이 포함되며, 종료 결과에는 순번을 표시하지 않습니다.

## 알림 저장과 전달

| 단계 | SQLite 상태 |
| --- | --- |
| event | kind, source event, 사용자 dedupe key, 안전한 same-origin path, 만료 |
| outbox | pending·leased·retry·completed·failed, due, lease, attempt |
| delivery | desktop 또는 web-push 대상별 상태, due, lease, ack·오류 |

알림 kind는 급식 게시, 세탁 종료 전·완료·사용 가능·주의, 출석 미완료,
LMS 로그인 필요입니다.

유효한 app session의 desktop은 일시적으로 오프라인이어도 event 만료
전까지 inbox delivery를 받고 `displayed`, `dismissed`, `failed`로
ack합니다. 유효한 30일 mobile session과 연결된 active subscription만
Web Push 대상입니다. 최대 10건씩 병렬 전송하며 provider TTL은 event의
남은 수명보다 길어질 수 없습니다. device 해제·session 만료·다른 계정
재연결 때 해당 Push와 pending delivery를 취소하거나 제외합니다.

알림 path는 `/app#attendance`, `/app#meals`, `/app#laundry` 같은
same-origin app 경로만 사용합니다.

## 모바일 pairing과 session 관리

QR payload는 `/pair#pairing=…&challenge=…` 형식이며 proof는 fragment에
있습니다. 수동 코드는 설치된 PWA가 Safari와 cookie storage를 공유하지
않는 iOS에서도 사용할 수 있습니다.

Claim 뒤 PC와 휴대폰은 installation ID 원문이 아닌 마지막 4자리 대문자
확인 코드를 함께 표시합니다. 사용자는 device label과 양쪽 코드를
확인하고 승인합니다. 승인과 mobile session·암호화 transport 저장은 한
SQLite transaction으로 처리합니다.
휴대폰이 완료 응답을 잃어도 같은 claim receipt로 2분 transport 안에서
재시도할 수 있습니다.

PC는 mobile session의 active·revoked·expired 상태와 생성·만료 시각을
조회하고 개별 revoke할 수 있습니다. 모바일은 자기 session을
로그아웃할 수 있습니다. revoke와 self logout은 해당 device의 Push
subscription도 해제합니다.

## 공개 campus source

기본 source:

```text
https://jungle-bell-api.yangsijun5528.workers.dev
```

| 기능 | upstream path | 공개 API |
| --- | --- | --- |
| 세탁 최신 상태 | `/v1/laundry/latest` | `/api/public/campus/laundry` |
| 급식 최신 상태 | `/v1/meals` | `/api/public/campus/meals` |
| 급식 이력 | `/v1/meals/history` | `/api/public/campus/meals/history` |

서버는 timeout, 전체 body 크기 제한, schema 검증, ETag·304, 마지막 정상
snapshot을 적용합니다. 첫 정상 snapshot은 알림 baseline이며 이후
변화만 event로 만듭니다.

## 주요 API surface

| 구분 | endpoint |
| --- | --- |
| liveness | `GET /api/health` |
| readiness | `GET /api/ready` |
| LMS identity | `POST /api/onboarding/lms-identity` |
| 공개 campus | `GET /api/public/campus/laundry`, `GET /api/public/campus/meals`, `GET /api/public/campus/meals/history` |
| pairing | `POST /api/pairings`, `POST /api/pairings/:id/claims`, `POST /api/pairing-claims`, `GET /api/pairings/:id`, `POST /api/pairings/:id/approve`, `POST /api/pairings/:id/complete` |
| dashboard | `GET /api/private/desktop/dashboard`, `GET /api/private/dashboard` |
| desktop sync | `POST /api/private/desktop/heartbeat`, `POST /api/private/desktop/attendance-snapshot` |
| desktop inbox | `GET /api/private/desktop/notifications`, `POST /api/private/desktop/notifications/:id/ack` |
| mobile 관리 | `GET /api/private/desktop/mobile-sessions`, `DELETE /api/private/desktop/mobile-sessions/:id`, `DELETE /api/private/mobile/session` |
| 개인 규칙 | meal rule, attendance rule, laundry watch, voluntary queue의 private GET·PUT·POST·DELETE |
| Push | VAPID public key, subscription PUT·DELETE, test POST |

모든 상태 변경 browser 요청은 정확한 `JB_PUBLIC_ORIGIN`을 요구합니다.
Origin이 없는 요청은 명시된 Tauri native onboarding·heartbeat·snapshot
경로만 허용합니다. API 응답은 `no-store`입니다.

## SQLite schema

현재 schema version은 3이며 새 플랫폼 전용입니다. 주요 데이터는 다음
그룹입니다.

- `users`, `external_identities`
- `desktop_devices`, `desktop_sessions`
- `pairing_challenges`, `pairing_claim_transports`, `device_sessions`
- `attendance_snapshots`
- `campus_public_snapshots`, `campus_source_state`
- `user_meal_rules`, `user_attendance_rules`
- `user_laundry_watches`, `laundry_voluntary_queue`,
  `laundry_queue_claims`
- `notification_events`, `notification_outbox`,
  `notification_deliveries`
- `push_subscriptions`, `push_delivery_dedupe`

`lms_sessions`와 `attendance_collector_runs`가 있는 과거 credential DB는
자동 migration하지 않고 `SQLITE_SCHEMA_RESET_REQUIRED`로 거부합니다.
현재 개편에는 이전 운영 사용자 데이터가 없다는 전제입니다.

## 서버 환경 변수

| 변수 | 기본값·요구 사항 |
| --- | --- |
| `NODE_ENV` | `development` 또는 `production`, 필수 |
| `HOST` | 기본 `127.0.0.1`; container `0.0.0.0` |
| `PORT` | 기본 `8787` |
| `JB_DB_PATH` | 기본 `.data/jungle-bell.sqlite` |
| `JB_BACKUP_DIRECTORY` | backup entrypoint 기본 `.backups` |
| `JB_WEB_ROOT` | 기본 build된 `apps/web/dist` |
| `JB_PUBLIC_ORIGIN` | production에서 path 없는 정확한 HTTPS origin |
| `JB_CAMPUS_DATA_API_URL` | production campus source base URL |
| `JB_SESSION_ENCRYPTION_KEY` 또는 `_FILE` | canonical base64 32바이트; production 필수, 둘 중 하나 |
| `JB_IDENTITY_HMAC_KEY` 또는 `_FILE` | 위 key와 다른 canonical base64 32바이트; production 필수 |
| `JB_VAPID_SUBJECT` | `mailto:` URI |
| `JB_VAPID_PUBLIC_KEY` | VAPID public key |
| `JB_VAPID_PRIVATE_KEY` 또는 `_FILE` | VAPID private key; 둘 중 하나 |
| `JB_TRUST_PROXY_HOPS` | 제공 Caddy 구성은 `1` |
| `JB_ALLOW_DEV_BOOTSTRAP` | development에서 정확히 `true`일 때만 route 등록 |

직접 secret 값과 `_FILE`을 동시에 설정하면 시작을 거부합니다. 제공
Compose는 file secret과 실제 VAPID 설정을 요구합니다.

Tauri release는 runtime 환경 변수를 사용하지 않습니다. build할 때 두
origin을 같은 HTTPS origin으로 고정합니다.

```bash
JB_APP_ORIGIN=https://bell.example.com \
JB_API_ORIGIN=https://bell.example.com \
npm run tauri:build
```

## 검증 명령

모든 명령은 `platform/`에서 실행합니다.

| 명령 | 범위 |
| --- | --- |
| `npm run verify` | API·웹·Tauri typecheck, 테스트, build, Rust lint·release check |
| `npm run smoke:platform` | 200명 dummy 상태·출석·dashboard·공개 campus·pairing·Push 등록 경계 |
| `npm run smoke:load` | 위 smoke와 k6 desktop·mobile·public API 부하 |
| `npm run smoke:campus-live` | 실제 campus source 계약 |
| `npm run smoke:container` | image, production config, health, SQLite 재시작 영속성 |
| `npm run db:backup -w @jungle-bell/api` | build된 API의 SQLite online backup |

고정 test file·test case 수나 latency 수치는 이 문서에 보존하지 않습니다.
각 실행의 출력과 revision을 CI 또는 smoke 기록에 함께 남기십시오.

## 수동 확인이 필요한 항목

- 실제 Google SSO와 2단계 인증
- 자연 access JWT 만료 뒤 WebView refresh cookie에 의한 일반 API 지속
- 실제 active 기수 기간의 `/attendance/today` 오전·오후 값 동기화
- 앱 재시작 뒤 LMS subject binding 확인
- 서로 다른 실제 PC의 동일 LMS 사용자 매핑
- 설치된 iOS·Android PWA의 수동 코드 연결
- 실제 Apple·Google Web Push 전달과 notification click
- Windows·macOS·Linux 네이티브 알림
- OCI Caddy TLS·header, 장시간 worker 실행
- off-host backup 복원

자동 더미 smoke는 이 수동 검증을 대체하지 않습니다.

## 현재 운영 제한

- health는 process liveness만 확인합니다. readiness는 SQLite query와
  DB filesystem의 최소 여유 공간을 확인합니다.
- rate limit은 단일 process 메모리 기반이며 재시작 시 초기화됩니다.
  인증 전 요청은 IP별, 인증된 mutation은 검증된 desktop/mobile
  session별로 계산해 공용 NAT의 사용자끼리 한도를 공유하지 않습니다.
  LMS onboarding은 200명×2대 PC를 수용하도록 공용 IP당 시간당 600회로
  제한합니다.
- 자동 key rotation migration은 없습니다.
- backup timer 예시는 로컬 retention을 포함하지만 restic off-host 전송과
  실패 경보는 운영 환경에서 별도로 연결해야 합니다.
- SQLite schema는 이전 server LMS collector DB와 호환되지 않습니다.
- 오프라인 앱 shell, write queue, 충돌 병합은 없습니다.
- 세탁 자율 대기열은 실제 예약이나 사용 권한이 아닙니다.
