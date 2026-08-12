# Jungle Bell 플랫폼 아키텍처

## 설계 결론

Jungle Bell은 PC가 Jungle LMS 세션과 출석 수집을 전담하고, Cloudflare
서버가 기기 연결·출석 snapshot·생활 설정·알림 전달 상태를 관리하는
구조입니다. 일반 웹, 설치된 PWA, Tauri PC 앱은 같은 시각 언어를 사용하지만
권한과 역할은 런타임별로 분리합니다.

이 구조는 이전 API, 데이터베이스, 로컬 설정과 호환되지 않습니다. 기존
세션이나 연결 정보를 변환하는 분기는 만들지 않으며 새 버전에서는 PC 등록과
모바일 연결을 다시 수행합니다.

```text
Jungle LMS ─ 전용 WebView ─ Tauri PC
                              │
                              ├─ 정규화한 출석 snapshot·heartbeat
                              ├─ 알림 delivery poll·ack
                              └─ 단기 WebView HTTP session bootstrap
                                          │
일반 웹 ─ 공개 정보 ─────────────── App Worker ─ DB binding ─ D1
Tauri UI ─ 공개·desktop-ui HTTP ────────────┤
설치 PWA ─ session·Web Push 등록 ───────────┤
                                           └─ R2 binding ─ R2
                                              ↑            ↑
                  OCI Jobs ─ 인증된 D1 gateway┘            │
                           ├─ 인증된 R2 gateway─────────────┘
                           └─ 수집·알림 계획·정리·Web Push
```

## 자격 증명 경계

LMS access cookie와 refresh cookie는 Tauri의 전용 LMS WebView profile에만
존재합니다. Rust가 cookie 원문을 추출하거나 서버로 전송하지 않습니다. LMS
페이지에 주입한 제한된 collector가 same-origin API를 호출하고, Rust에는
검증 가능한 LMS 상태와 정규화한 출석 snapshot만 전달합니다.

PC가 서버에 사용하는 자격 증명은 LMS 자격 증명과 무관한 임의의 Jungle Bell
desktop credential입니다. 서버는 원문 대신 hash만 저장하고 PC는 원문을 운영체제
credential vault에 보관합니다. 과거 앱 전용 파일은 검증 후 vault로 한 번 이전하고
제거합니다.

React 대시보드는 장기 desktop credential을 받지 않습니다. Rust가 장기 credential로
7분짜리 opaque desktop-ui session을 발급받아 호출한 WebView의 메모리에만 전달합니다.
이 session은 exact Tauri origin, 부모 desktop session과 고정 scope에 묶이며
`/api/desktop-ui/*`의 폐쇄형 route에서만 사용할 수 있습니다. 공개 세탁·급식도
Rust proxy를 거치지 않고 React가 `/api/public/*`를 직접 호출합니다. LMS checker,
heartbeat, 운영체제 알림과 로컬 설정은 계속 Rust 경계에 남습니다.

이 경계에서는 동일 LMS 사용자를 여러 PC에서 자동 병합할 근거가 없습니다.
각 PC 등록은 별도 계정 경계가 되고, 모바일 PWA는 사용자가 해당 PC에서 직접
승인한 pairing으로만 연결됩니다.

## 상태 소유권

- Tauri PC: LMS session, LMS 로그인 상태, 주기적 출석 수집, 네이티브 알림 표시.
- App Worker와 D1: HTTP API, OCI 전용 고정 D1 gateway, 대시보드·PWA·Markdown
  블로그 정적 자산, PC·모바일 session, pairing, 최신 출석 snapshot, 사용자 설정,
  알림 event·intent·delivery, Web Push subscription.
- OCI Jobs: 공개 급식·세탁 수집, App Worker gateway를 통한 D1/R2 ingest,
  출석·급식·세탁 알림 계획, housekeeping, 대기 중 Web Push
  전송.
- R2: 공개 수집 원본, 정규화 자료, 이미지와 복구 자료.
- 일반 웹: 공개 급식·세탁 조회와 설치 안내만 제공.
- 설치 PWA: 서버에 동기화된 출석 조회, 생활 설정, 연결 관리와 Web Push.

서버는 PC를 원격 조작하지 않습니다. 데스크톱 inbox에는 표시할 알림 delivery만
들어가며 LMS 요청이나 세탁 조작 같은 명령을 넣지 않습니다.

서비스 설정은 소유권에 따라 나눕니다. 출석·급식 알림과 시간대는 D1의 계정 설정으로
저장해 연결된 PC와 PWA가 공유합니다. 자동 시작·자동 업데이트·사용 통계·디버그와
로그 폴더는 해당 PC의 실행 환경에만 영향을 주므로 로컬 설정과 제한된 Tauri IPC가
소유합니다. 로그 폴더 command는 사용자 경로를 받지 않고 앱 전용 로그 디렉터리만
엽니다.

사용 통계는 release 빌드에서 명시된 로컬 설정이 켜진 동안만 보냅니다. 설치 ID는
WebView에 노출하지 않고 Rust 안에서 SHA-256 해시로 가명 처리하며, 앱 실행·설정
변경·앱 버전·운영체제 외의 LMS 계정, 출석·식단·세탁 내용은 수집하지 않습니다.
PostHog person profile도 만들지 않습니다.

App Worker는 HTTP 요청만 처리하며 Cron Trigger나 VAPID private key를 갖지
않습니다. 오래 걸리거나 주기적인 작업은 OCI Jobs가 매분 한 번 실행하고 `flock`으로
중복 실행을 막습니다. 한 저장소와 한 서버 패키지에서 두 실행 진입점을 관리하지만,
요청 처리와 장기 작업의 장애 경계는 분리합니다.

OCI Jobs는 D1 관리 자격 증명이나 database 식별자를 갖지 않습니다. 환경별로 고정된
App Worker의 `/internal/jobs/d1`, `/internal/jobs/r2`에 32자 이상의 shared secret으로
인증합니다. Worker는 자기 `DB`, `DATA_BUCKET` binding에서만 허용된 query, batch,
object key 작업을 실행합니다. 따라서 production Jobs가 test D1/R2를 선택하거나
반대 환경의 대상을 요청으로 지정할 수 없습니다. OCI에는 Cloudflare 관리 자격 증명이나
R2 S3 key를 두지 않으며, VAPID private key만 환경별 secret 파일에 둡니다.

한 OCI cycle은 `collector → attendance → meals → laundry → housekeeping → push`
순서를 유지합니다. 각 단계의 실패는 다음 단계를 막지 않으며 결과와 실패 원인은 R2
`logs/jobs-runs/`에 기록됩니다. 수집 예약 시각은 collector의 분 단위 관측에만 쓰고,
그 뒤 lifecycle과 Push는 각 단계가 실제 시작한 현재 시각으로 만료·lease를 계산합니다.
세탁 원본은 매분, 급식 원본은 기본 5분마다 수집합니다.

## 알림 전달

한 source event는 사용자별 intent 하나로 dedupe한 뒤 활성 대상마다 delivery를
만듭니다. 같은 이벤트가 모든 활성 PC inbox와 모든 활성 PWA Push subscription에
전달되며 대상별로 성공, 실패, 재시도와 acknowledgement를 기록합니다.

서버는 오래된 출석 snapshot을 최신 상태로 추측하지 않습니다. 최신 snapshot이
출석 완료나 비활성 기수를 증명하면 알림을 만들지 않고, 활성 기수의 미완료 상태를
증명하면 일반 출석 알림을 만듭니다. PC 오프라인, LMS 로그인 필요, snapshot 누락·
만료 상태에서는 출석 여부를 단정하지 않고 `미확인` 경고를 만듭니다. 이 경고도
다른 event와 동일하게 모든 활성 PC와 PWA 대상으로 전달합니다.

Web Push는 PWA가 백그라운드에서 LMS를 조회하는 수단이 아닙니다. 서버에 이미
동기화된 상태와 서버가 만든 경고를 전달하는 수단입니다. 며칠 동안 출석 수집을
유지하려면 PC 앱이 실행 중이어야 하며, PWA service worker가 PC 역할을 대신하지
않습니다.

## UI 원칙

공통 UI는 기존 Rust 로컬 앱의 Pretendard 글꼴, 4px 간격 체계, 밝은 fog 배경,
border 없는 paper 카드, leaf 강조색과 상태별 soft 배경을 유지합니다. 넓은
화면에서는 shadcn/ui의 접을 수 있는 왼쪽 navigation rail을 사용합니다. 모바일
PWA에서는 같은 Sidebar의 Sheet와 safe area를 반영한 하단 navigation을 함께
사용합니다. 홈·출석·세탁실·식단만 주요 navigation에 두고, 알림 센터와 기기
연결은 별도의 개인 도구 영역으로 분리합니다.

급식 기록 Calendar는 shadcn/ui가 제공하는 React DayPicker 기반 구현을 유지합니다.
월 이동과 날짜 선택뿐 아니라 비활성 날짜, 한국어 locale, 키보드 포커스와 접근성
계약까지 이 계층이 담당하므로 수동 달력으로 중복 구현하지 않습니다.

홈 화면은 오늘의 출석, 과정 D-Day, Jungle Campus 연결, 세탁과 급식을
요약합니다. 알림 기록과 수신 상태는 전역 알림 센터에서 확인합니다. 시스템
트레이 아이콘은 별도 목록 창을 만들지 않고 홈을 엽니다. 일반 웹에서는 개인
출석·알림 동작 대신 PC 앱 또는 PWA 설치 안내를 표시합니다. Jungle Campus는
웹·PWA에서는 외부 바로가기이고, PC에서는 전용 LMS WebView의 연결 상태와 함께
표시합니다. 댓글 없는 Markdown 블로그는 App Worker의 정적 자산으로 함께
배포하며 대시보드 실행 코드나 사용자 session에 의존하지 않습니다.

`display-mode: standalone`과 iOS standalone 신호는 화면 기능을 나누고 일반
웹에서 설치를 유도하기 위한 UI surface 판정입니다. 서버가 위조 불가능하게
검증하는 PWA attestation은 아닙니다. 같은 origin의 브라우저 session이 설치
PWA에서만 사용됐음을 암호학적으로 보장할 수 없으므로, 실제 권한 경계는 모바일
HttpOnly session과 서버의 사용자·기기 검증입니다.
