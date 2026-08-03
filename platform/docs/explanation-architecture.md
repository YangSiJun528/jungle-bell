# Jungle Bell 아키텍처

## 설계 결론

Jungle Bell은 서비스 상태를 단일 OCI 서버가 관리하되, LMS session만 각
사용자의 Tauri PC에 남기는 혼합 구조입니다. LMS 운영자가 OAuth client나
공식 외부 API를 제공하지 않으므로 서버가 Google SSO를 자동화하거나 여러
사용자의 refresh cookie를 보관하지 않습니다.

이 구조는 다음 요구를 함께 만족합니다.

- 웹과 모바일에서 같은 최신 서비스 상태를 조회
- 사용자별 출석·급식·세탁 알림을 서버에서 계획
- Google SSO와 2단계 인증은 사용자가 PC에서 직접 수행
- LMS refresh cookie 유출 범위를 해당 PC로 제한
- 최대 200명 규모를 한 VM과 SQLite로 운영

```text
공개 웹 ───────────────┐
모바일 PWA ─ HTTPS ────┼─ Fastify + React ─ SQLite
Tauri main ─ HTTPS ────┘          │             │
   ▲                               │             ├─ Web Push
   ├─ desktop inbox ───────────────┘             │
   └─ 전용 LMS WebView ─ Jungle LMS / Google SSO│
          │                                      │
          └─ 정규화한 출석 snapshot ─────────────┘
```

공개 웹, 모바일 PWA, Tauri main 화면은 같은 React 앱을 사용하지만 실제
권한 경계는 Fastify의 session·scope 검사입니다. URL이나 화면에서 메뉴를
숨기는 것은 권한 검사가 아닙니다.

## 사용자 식별과 PC 등록

서버 사용자 기본키는 임의 UUID입니다. LMS ID나 email을 직접 기본키로
쓰지 않습니다.

1. 사용자가 Tauri의 전용 LMS WebView에서 Google SSO와 2단계 인증을
   완료합니다.
2. WebView 안의 agent가 `/api/v2/me` 응답에서 immutable `id`를
   확인합니다. email fallback은 없습니다.
3. Tauri는 정확한 Jungle LMS host·path·보안 속성에 맞는
   `access_token` cookie 하나, 로컬 installation UUID, 그리고
   `SHA-256(protocol-domain || installation UUID || LMS ID)` 결합 증명을
   onboarding endpoint로 보냅니다. LMS ID 원문은 보내지 않습니다.
4. 서버는 받은 access cookie로 `/api/v2/me`를 정확히 한 번 호출합니다.
5. 서버는 `/me`에서 확인한 ID로 같은 결합 증명을 계산해 Tauri가 본
   계정과 서버가 검증한 계정이 같은지 상수 시간 비교한 뒤, 별도 identity
   secret으로 domain-separated
   `HMAC-SHA-256(LMS ID)`를 계산하고 내부 사용자 UUID를 찾거나
   생성합니다.
6. 서버는 Tauri용 HttpOnly app session을 발급하고 LMS ID 원문과 access
   cookie를 저장하지 않습니다.

`refresh_token`은 onboarding 요청에 포함되지 않으며 서버로 이동하지
않습니다. 서버 DB에는 LMS session·cookie table이 없습니다.

같은 LMS 계정을 다른 PC에서 다시 검증하면 동일 HMAC이 계산되므로 기존
서버 사용자에 새 desktop device가 추가됩니다. 기존 PC 승인이나 session
복사는 필요하지 않습니다. LMS 계정 자체가 바뀐 예외 상황의 사용자
병합은 자동화하지 않고 운영자가 별도로 처리합니다.

Identity HMAC key를 잃거나 다른 값으로 바꾸면 새 PC 검증을 기존 사용자와
연결할 수 없습니다. DB와 이 key를 함께 복구해야 합니다.

## Tauri가 소유하는 LMS session

Tauri는 외부 Chrome, 별도 Chromium helper, Neko를 요구하지 않습니다.
숨겨진 수집 창과 사용자가 보는 로그인 창은 같은 영구 WebView profile을
사용합니다.

LMS origin에만 주입되는 agent는 read-only로 다음 API를 호출합니다.

- `/api/v2/me`
- `/api/v2/me/cohorts`
- 선택한 cohort의 오늘 출석 API

agent는 응답 크기와 형태를 제한하고 Rust에 다음 상태만 보냅니다.

- LMS 연결됨과 immutable subject
- 정규화된 cohort·오전·오후 출석 snapshot
- 재로그인 필요

Rust도 IPC payload를 다시 검증합니다. 서버에는 subject를 보내는 대신
등록 시 access cookie로 다시 검증하고, 평상시에는 heartbeat와 정규화된
snapshot만 전송합니다. 여러 PC가 snapshot을 보내면 `collectedAt`이 더
새로운 값만 채택됩니다.

일반 LMS API 요청이 access JWT 만료를 만났을 때 access 갱신은 LMS와
WebView cookie jar가 처리합니다. Jungle Bell은 존재하지 않는 refresh
endpoint를 추측하지 않습니다. refresh cookie까지 만료되면 agent가
`login-required`를 보고하고 사용자가 PC에서 다시 로그인합니다.

앱 재시작 때 이전 app session을 다른 LMS 계정과 잘못 결합하지 않도록
Tauri는 installation UUID와 LMS subject의 domain-separated SHA-256
digest만 로컬 파일에 저장합니다. 원문 subject는 저장하지 않습니다.
메인 WebView는 원격 서비스를 로드하지 않고 로컬 개인정보 보호 화면에서
대기합니다. 현재 WebView의 subject와 서버가 access cookie로 확인한
subject가 모두 일치해야 원격 dashboard를 로드합니다. 확인 전에는
heartbeat가 LMS 상태를 `unknown` 또는 `login-required`로만 보고할 수
있고, native inbox는 본문에 사용자 상태가 없는 `login-required`만
표시·확인합니다. 급식·세탁·출석 알림은 표시하거나 ACK하지 않아 lease
만료 뒤 subject 확인이 끝난 세션에서 다시 받습니다. 출석 snapshot은
확인 전까지 업로드하지 않습니다.

연동 해제는 서버 app session, Tauri app cookie, 로컬 subject binding,
Jungle LMS의 access·refresh cookie를 제거합니다. Google domain의 SSO
cookie는 제거하지 않습니다.

## 공개 급식·세탁 데이터

서버는 운영 중인 Jungle Bell campus API를 source로 사용합니다.

```text
https://jungle-bell-api.yangsijun5528.workers.dev
```

급식, 급식 이력, 세탁 응답에 다음 방어를 적용합니다.

- 요청 timeout과 최대 본문 크기
- Zod schema 검증
- ETag와 `304 Not Modified`
- SQLite에 마지막 정상 snapshot 저장
- 실패 시 backoff와 마지막 확인 시각·stale 상태 노출

초기 snapshot은 알림 폭주를 막기 위한 baseline입니다. 이후 급식
`contentSha`와 세탁 상태 전환을 source event로 만듭니다. upstream
장애 중에는 마지막 정상 값이 stale 표시와 함께 유지됩니다.
공개 급식 카드는 제목과 게시 시각을 KST service date로 정규화해 오늘
게시물만 표시하고, 이전 날짜 게시물은 최근 식단으로 분리합니다.

세탁 watch는 한 동작의 종료 전·완료·오류 또는 사용 가능 전환을 대상으로
하는 일회성 규칙입니다. 조건이 끝나면 자동으로 완료됩니다.

`laundry_voluntary_queue`는 사용자가 희망 순서를 공유하는 기능입니다.
물리적 기기를 잠그거나 실제 예약·사용 권한을 만들지 않습니다. 사용
가능 전환 때 대기열 선두에 알리고, claim도 서버 알림 처리를 위한 짧은
상태일 뿐 현실의 사용권이 아닙니다. 한 기기에는 선두 한 명만 5분 동안
claim되며, 기기가 계속 사용 가능하면 만료 뒤 다음 선두로 넘어갑니다.
waiting 또는 아직 만료되지 않은 claim이 있을 때 같은 사용자는 같은
대기열에 다시 들어갈 수 없습니다. 사용자는 현재 순번과 최근 24시간의
claim·만료 결과를 함께 확인할 수 있습니다.

## 알림 모델

알림은 SQLite에서 세 단계로 관리합니다.

1. source event: 급식 게시, 세탁 상태 전환, 출석 미완료, LMS 재로그인
2. intent: 사용자 규칙을 적용한 dedupe 가능한 알림
3. delivery: 활성 desktop device 또는 유효한 mobile Web Push subscription

`node-cron`은 campus collector와 notification worker를 깨우는 역할만
합니다. due 시각, lease, 재시도 횟수, backoff, acknowledgement는
SQLite가 기준이므로 process 재시작 뒤에도 유지됩니다.

출석 알림은 사용자가 명시적으로 켠 오전·오후 규칙에만 생성됩니다.
활성 cohort의 15분 이내 최신 snapshot만 사용하며, 마감 전 60분·15분·
5분 구간과 마감 직후 구간별로 dedupe합니다. PC가 꺼져 있거나 snapshot이
오래됐으면 서버는 출석 상태를 추측하지 않습니다.

급식 알림은 선택한 식사 종류의 새 게시물에 생성됩니다. 세탁 watch는
조건을 한 번 처리한 뒤 완료되고, 대기열 알림도 해당 상태 전환에
dedupe됩니다.

notification worker의 같은 `node-cron` wake는 시작 직후와 이후 최대
1시간 간격으로 보존 기간 정리도 실행합니다. terminal notification
event·outbox·delivery와 폐기·만료 session은 terminal 시점 이후 30일,
완료·취소된 세탁 watch와 대기열·claim은 30일, 만료 pairing
challenge·claim transport는 만료 이후 7일 보관합니다.
active outbox·delivery와 active session은 기간과 무관하게 삭제하지
않으며, 정리는 foreign key가 켜진 단일 SQLite transaction입니다.

데스크톱은 서버 inbox를 polling해 운영체제 알림을 표시하고 결과를
ack합니다. 유효한 app session이 있는 PC에는 일시적으로 오프라인이어도
delivery를 만들며, event 만료 전 PC가 돌아오면 inbox에서 받습니다.
모바일은 만료되지 않은 365일 session과 연결된 유효한 subscription에만
Web Push를 보냅니다. worker는 최대 10건을 병렬 전송하고 Push TTL을
event의 남은 수명 이하로 제한합니다. session 해제·만료 때 해당
subscription과 pending delivery도 더 이상 사용하지 않습니다.

## 모바일 PWA 연결

모바일은 LMS에 직접 로그인하지 않고 검증된 PC를 신뢰의 시작점으로
사용합니다.

1. PC가 2분짜리 QR proof와 10자리 Crockford Base32 수동 코드를
   생성합니다.
2. 휴대폰이 QR fragment 또는 설치된 PWA 안의 수동 코드로 claim합니다.
3. 휴대폰과 PC에 installation ID 원문 대신 표시되는 마지막 4자리
   확인 코드가 같은지 확인한 뒤 PC에서 승인합니다.
4. 휴대폰이 승인 결과를 받아 365일 절대 만료 HttpOnly mobile session을
   발급받습니다.

QR secret은 URL fragment에 있으므로 일반 HTTP request, access log,
Referer에 포함되지 않습니다. 수동 코드는 서버에 hash만 저장되며
2분·일회용이고 코드별 시도 횟수가 제한됩니다.

iOS의 홈 화면 PWA는 Safari와 cookie·storage가 분리될 수 있으므로,
Safari에서 QR을 연 뒤 설치된 PWA로 session이 자동 이전된다고 가정하지
않습니다. 설치된 PWA 화면에서 PC의 10자리 코드를 입력하는 경로가
기본 복구 수단입니다.

운영 HTTPS에서는 session token을 `Secure`, `SameSite=Strict`,
`Path=/`인 `__Host-jb_device` HttpOnly cookie로만 전달합니다. 서버에는
token의 SHA-256 hash, scope, 생성·절대 만료·최근 사용 시각을 저장합니다.
만료는 활동에 따라 연장되지 않으며 cookie의 `Max-Age`도 DB에 저장된 남은
수명과 맞춥니다. 최근 사용 시각은 인증 요청마다 쓰지 않고 최대 6시간에
한 번만 갱신해 SQLite 쓰기를 제한합니다.

PC에서는 연결된 모바일 session의 상태, 생성·최근 사용·만료 시각과 서버의
활성 Web Push subscription 유무를 확인하고 개별 해제할 수 있습니다.
모바일에서도 자기 session을 해제할 수 있습니다.
다른 계정으로 다시 연결하면 이전 mobile session과 Web Push 연결을
정리한 뒤 새 session을 사용합니다.

### 인증 구현 선택

이 흐름에는 범용 로그인 프레임워크를 추가하지 않습니다. Auth.js나
Better Auth가 해결하는 OAuth·email·passkey 로그인과 달리, 현재 신뢰의
시작점은 이미 LMS 검증을 마친 Tauri PC입니다. 2분짜리 일회용 claim,
양쪽 확인 코드, installation 결합, 제한된 scope, PC 강제 해제와 Push
정리는 서비스 고유 규칙이므로 범용 인증 session을 병행하면 identity와
session 체계만 두 개가 됩니다.

대신 cookie parsing은 `@fastify/cookie`, 요청 제한은
`@fastify/rate-limit`, 입력 경계는 Zod, 원자적 승인·해제는
`better-sqlite3` transaction, token 생성·hash·암호화는 Node.js
`crypto`를 사용합니다. PC 없이 PWA에서 직접 가입하는 요구가 생길 때만
별도 passkey 로그인 계층과 계정 연결 정책을 추가합니다.

## SQLite와 단일 서버

SQLite는 VM 로컬 영속 디스크에서 다음 설정으로 열립니다.

- WAL과 1,000-page auto-checkpoint
- `synchronous=FULL`
- foreign key enforcement
- 5초 `busy_timeout`
- transaction 기반 migration
- SQLite online backup

지원 topology는 app container와 Node.js process가 각각 하나인
active-singleton입니다. `node-cron`의 중복 방지는 process-local이므로
같은 DB를 사용하는 두 process를 동시에 실행하면 안 됩니다. NFS,
공유 volume, 여러 VM도 지원하지 않습니다.

현재 목표인 최대 200명에서는 이 단순성이 운영 비용보다 중요합니다.
replica나 무중단 failover가 필요해지면 SQLite만 교체하는 것이 아니라
PostgreSQL, 공유 rate limit, 분산 outbox lease, worker ownership을 함께
설계해야 합니다.

## 자격 증명과 저장 위치

| 값 | 저장 위치 | 서버 영속 저장 |
| --- | --- | --- |
| LMS access·refresh cookie | Tauri LMS WebView profile | 없음 |
| LMS immutable ID | 검증 중 메모리 | HMAC만 저장 |
| 로컬 LMS account binding | Tauri app data | installation별 SHA-256 digest |
| Tauri app session | main WebView HttpOnly cookie | token SHA-256 hash |
| 모바일 session | PWA HttpOnly cookie | token SHA-256 hash |
| Web Push subscription | browser와 SQLite | 전송에 필요한 endpoint·공개 암호화 material |

API logger는 Cookie, Authorization, Set-Cookie를 가립니다. Tauri는
정확한 window label과 origin에 최소 IPC capability만 부여하며 shell과
일반 filesystem 권한을 제공하지 않습니다.

인증 전 endpoint의 rate limit key는 client IP입니다. 인증 뒤 desktop과
mobile mutation은 서버가 먼저 검증한 app/device session을 key로
사용합니다. 따라서 기숙사·교육장처럼 최대 200명이 같은 공인 IP를 쓰는
환경에서도 한 사용자의 Push 등록이나 설정 변경이 다른 사용자의 한도를
소진하지 않습니다. 임의 cookie 문자열은 유효한 session으로 검증되지
않으면 IP key로 돌아가므로 한도 우회 수단이 되지 않습니다.

## 의도적으로 지원하지 않는 것

- 서버의 LMS refresh cookie 저장·주기적 LMS 로그인 자동화
- Neko나 원격 브라우저 화면 제공
- 외부 Chrome 설치 경로 탐색
- OAuth가 없는 상태에서 Google 계정 credential 자동 입력
- 오프라인 상태 변경과 여러 기기의 충돌 병합
- 다중 Node process·container replica·VM
- 자율 세탁 대기열을 실제 예약으로 보장하는 기능
