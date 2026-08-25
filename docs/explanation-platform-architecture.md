# Jungle Bell 플랫폼 아키텍처

## 설계 결론

Jungle Bell은 PC가 Jungle LMS session과 출석 수집을 전담하고, Jungle Bell Spring
서버가 기기 연결·출석 snapshot·생활 설정·공개 데이터·알림 전달 상태를 관리합니다.
브라우저, 설치 PWA, Tauri PC 앱은 같은 SPA와 HTTP 계약을 사용하며 운영체제 기능만
플랫폼 어댑터의 capability로 분리합니다.

저장소도 실행 경계와 같은 세 개의 최상위 프로젝트로 나눕니다.

```text
server/    Spring Core·API·Worker
frontend/  공통 Vite·React SPA와 Web·PWA·Tauri 어댑터
desktop/   Tauri Rust 런타임, capability와 번들 설정
```

`frontend`는 독립 npm 프로젝트입니다. 웹 빌드는 `dist/web`, Tauri용 UI 빌드는
`dist/desktop`에 생성합니다. PWA는 별도 React 앱이 아니라 Web 어댑터의 설치·Push
capability이며, 두 빌드는 같은 `DashboardApp`에 서로 다른 어댑터를 주입합니다.
Tauri PC 앱의 지원·배포·CI 대상은 macOS와 Windows이며 Linux는 지원하지 않습니다.

기존 서버 세션이나 연결 정보와 호환하지 않습니다. 새 버전에서는 PC 등록과 모바일
연결을 다시 수행합니다. 이전 서버에서 옮기는 데이터는 공개 세탁·급식 기록뿐입니다.

```text
Jungle LMS ─ checker WebView ─ Tauri PC
                               │
                               ├─ 출석 snapshot·heartbeat
                               ├─ 알림 poll·ack
                               └─ 단기 WebView HTTP session bootstrap
                                           │
설치 PWA ─── cookie ────────────────┐         │
일반 웹 ──── 공개 HTTP ─────────────┤         │
공통 React SPA ─ 공개·계정 HTTP ───┼─ Spring API ────── PostgreSQL
Tauri adapter ─ jbui·native IPC ───┘                        ▲
                                                            │
                                      Spring Worker ─────────┤
                                      ├─ 세탁·급식 수집      │
                                      ├─ 알림 계획·전송      │
                                      └─ housekeeping        │
```

## 실행부를 분리하고 Core를 공유하는 이유

이전 구조는 HTTP Worker, 원격 SQL/object gateway, 별도 Jobs 런타임에 같은 도메인
규칙이 나뉘어 있었습니다. 새 구조는 Spring MVC 호출부와 scheduler 호출부를 별도
프로세스로 두고 Spring Data JDBC와 도메인 로직을 Core 모듈로 공유합니다.

- API와 Worker가 같은 domain model, 저장소 port와 transaction 규칙을 사용합니다.
- 세탁·급식 이미지도 PostgreSQL에 저장해 별도 object gateway를 제거합니다.
- 정적 웹 자산은 API JAR에 포함하고 API와 Worker 이미지는 같은 Docker build에서
  생성합니다.
- 수집 실패가 HTTP server의 가용성에 영향을 주지 않도록 JVM 수준에서도 분리합니다.

named Cloudflare Tunnel은 `https://jungle-bell.sijun-yang.com`을 API에 연결하는 정식
ingress입니다. 애플리케이션 실행이나 데이터 저장은 담당하지 않습니다.

## 자격 증명 경계

LMS access·refresh cookie는 Tauri의 전용 checker WebView profile에만 존재합니다.
Rust가 원문을 추출하거나 서버로 보내지 않습니다. 제한된 same-origin collector가 LMS
상태와 정규화한 출석 snapshot만 Rust로 전달합니다.

PC가 Spring 서버에 쓰는 자격 증명은 LMS와 무관한 `jbd_` credential입니다. 서버는
hash만 저장합니다. Windows는 원문을 Credential Manager에 보관하고 macOS는 앱 전용
mode 0600 파일에 저장합니다.

React 대시보드는 장기 credential을 받지 않습니다. Rust가 7분짜리 `jbui_` session을
발급받아 WebView 메모리에만 전달합니다. 이 session은 exact Tauri origin과 부모 PC
session에 묶이고 `/api/me/*`만 호출할 수 있습니다. 공개 세탁·급식도 Rust
proxy 없이 React가 직접 HTTP로 조회합니다.

모바일 PWA는 PC에서 명시적으로 승인한 pairing으로만 연결됩니다. 설치 전 브라우저는
권한 없는 단기 handoff cookie만 준비하고, 설치형 PWA가 처음 열릴 때 claim을 시작합니다.
handoff, pending claim, 모바일 session credential은 Secure·Strict HttpOnly cookie에만
저장합니다.

## 상태 소유권

- Tauri PC: LMS session, LMS 로그인 상태, 출석 수집, 네이티브 알림, PC 로컬 설정.
- Spring API: HTTP API, 정적 웹, 인증, pairing, 최신 출석 snapshot, 개인 설정,
  알림과 delivery 조회.
- Spring Worker: 공개 데이터 수집, 알림 계획·Web Push, housekeeping.
- Spring Core: 두 실행 모듈이 공유하는 도메인 로직, 저장소 port와 JDBC adapter.
- PostgreSQL: session hash, 설정, 공개 세탁·급식 기록과 이미지, 알림 상태.
- 일반 웹: 인증 없이 공개 생활 정보만 조회.
- 설치 PWA: 공개 생활 정보, 동기화된 출석·D-Day, 생활 설정, 연결 관리와 Web Push.

PC 대시보드는 수집 직후의 검증된 로컬 출석 snapshot을 먼저 표시합니다. 같은 snapshot의
서버 업로드는 모바일 공유와 알림 자동화를 위한 별도 동기화 단계입니다. 따라서 서버
동기화가 잠시 늦어져도 PC의 출석 표시는 유지하며, checker 관측 자체가 오래되거나 LMS
인증이 끊긴 경우에만 출석 최신성 문제로 취급합니다. PWA는 계속 서버 snapshot만 사용합니다.

서버는 PC를 원격 조작하지 않습니다. 데스크톱 inbox에는 표시할 알림 delivery만
들어가며 LMS 요청이나 세탁 조작 명령을 넣지 않습니다.

출석·급식 알림 설정은 PostgreSQL의 계정 설정으로 저장해 PC와 PWA가 공유합니다.
자동 시작·자동 업데이트·디버그·로그 폴더는 해당 PC에만 영향을 주므로 로컬 설정과
제한된 Tauri IPC가 소유합니다. 사용 통계 선택은 PC 설정 화면에서 편집하지만 연결된
PWA에도 같은 gate가 필요하므로 nullable 로컬 상태를 서버 계정 preference에
동기화합니다.

## 통계 식별 단위와 설정을 분리한 이유

Jungle Bell의 계정은 이름이나 LMS 학번으로 만들지 않습니다. PC 앱이 무작위 UUID v4
installation identity를 만들고 등록하면 서버가 별도의 무작위 계정 UUID를 발급합니다.
연결된 PWA는 그 서버 계정을 공유합니다. 인증 사용 통계는 installation identity가 아닌
서버 계정 UUID를 기준으로 일일 중복을 제거합니다.

이 구조는 LMS credential을 통계에서 분리하지만 사람 수를 알려 주지는 않습니다. 재설치나
identity 초기화는 새 계정을 만들 수 있고 한 사람이 여러 PC를 사용할 수 있으며 여러
사람이 하나의 PC 설치를 공유할 수도 있습니다. 따라서 서버 계정은 활성 계정, installation
identity는 PC 앱 설치를 운영하기 위한 식별값일 뿐 자연인이나 물리 하드웨어와 일대일로
해석하지 않습니다. 익명 방문자는 날짜별 HMAC이라 다음 날의 같은 브라우저도 연결할 수
없습니다. 인증 계정 수와 익명 방문자 수를 합쳐 고유 사람 수를 만들지 않는 이유입니다.

통계 선택은 두 범위로 나눕니다.

- PC와 연결 PWA는 서버 계정 preference를 공유합니다. `null`은 아직 결정을 확인하지
  못한 pending 상태이고 유효 동작은 OFF입니다. `false`도 OFF, `true`만 ON입니다.
  설정 충돌을 피하기 위해 현재 편집자는 PC 서비스 설정 하나이고 PWA에는 같은 서버
  gate만 적용합니다.
- 일반 Web과 연결되지 않은 PWA는 계정이 없으므로 브라우저별 익명 opt-out을 사용합니다.
  로컬 저장소가 즉시 전송을 막고 first-party HttpOnly cookie가 서버에서도 거부를
  집행합니다. 이 거부는 계정 preference를 바꾸지 않습니다.

과거 설정은 새 기본값으로 덮지 않습니다. v3의 `false`는 기본값과 구분되는 명시적
거부라서 승계합니다. 반면 v3의 `true`는 당시 기본값이므로 명시적 허용으로 간주하지
않고, 선택 필드가 없던 v4와 함께 pending/OFF로 옮깁니다. 설정 파일과 installation
identity를 모두 처음 만든 완전 신규 설치만 기본 ON입니다. 설정 파일이 손상됐거나
읽히지 않으면 OFF로 동작해 서버의 과거 값을 근거로 자동 활성화하지 않습니다.

자동 UI 열림 reporter는 Web·PWA production 빌드와 Desktop release 빌드에만 둡니다.
개발 빌드의 반복 실행이 운영 통계를 오염시키지 않기 위한 경계입니다. 기능 이용 기록은
클라이언트가 이벤트를 제출하는 구조가 아니라 서버가 허용된 업무 동작의 성공을 확인한
뒤 내부에서만 기록합니다. 서버는 client build를 판별하지 않으므로 개발 client가 실제
업무 API를 호출하고 계정 preference가 ON이면 그 기능 메트릭은 기록될 수 있습니다.

## 원자료 기록과 집계를 분리한 이유

UI 열림 API는 요청 thread에서 원자료를 PostgreSQL에 바로 기록하거나 정책에 따라
생략합니다. `204 No Content`는 새 기록, 같은 날 중복, preference OFF, 전역 kill switch
중 어느 경우인지 노출하지 않는 공통 성공 응답입니다. 따라서 `204`는 Worker가 작업을
접수했거나 집계를 마쳤다는 뜻이 아닙니다. 일시적인 DB 장애만 `503`으로 구분해 제한된
클라이언트 재시도를 허용하고, 통계 실패가 화면 이용이나 계정 기능을 막지 않게 합니다.

Worker는 매시간 원자료를 일별 요약으로 재계산하고 보존기간을 집행합니다. 익명 화면
원자료는 2일, 계정 화면 원자료는 7일, 계정 기능 원자료는 30일 뒤 삭제 대상이 됩니다.
요약에는 계정 UUID나 방문자 HMAC이 없으며 최대 730일 뒤 삭제 대상이 됩니다. 이 기간은
Worker의 삭제 cutoff이지 해당 기간 동안 데이터 제공을 보장하는 가용성 SLA는 아닙니다.

사용자가 수집을 끄는 것은 이후 기록에 적용됩니다. 이미 수집된 원자료는 각 보존기간이
끝날 때까지 남고 재집계에 반영됩니다. 개인별 기여분을 다시 분리할 수 없는 일별 요약은
preference 변경을 이유로 역삭제하지 않습니다. 계정 자체를 삭제하면 foreign key로 연결된
인증 원자료는 즉시 삭제되고, 아직 원자료 보존 범위인 최근 요약은 다음 재집계에서 조정될
수 있습니다. API의 `204`, API readiness, Worker 집계 성공은 서로 다른 신호이며 Worker
성공은 Tailscale SSH로 운영 서버에 접속한 뒤 호스트 loopback의
`/actuator/info`에서 `usageMetrics.aggregation`과 마지막 성공 시각을 확인합니다.
Actuator는 공개 API port와 Cloudflare Tunnel에 등록하지 않습니다.

## 공개 데이터와 자동화

Spring scheduler는 세탁 source를 매분 수집하고 급식 source를 주기적으로 확인합니다.
정규화한 결과만 공개 API에 사용하고 source별 마지막 시도·성공·실패를
`source_state`에 저장합니다.

세탁 데이터는 content version과 minute observation을 분리해 동일 상태를 중복
저장하지 않습니다. 급식 이미지는 SHA-256으로 식별해 PostgreSQL `BYTEA`에 저장하고
immutable asset URL로 제공합니다.

알림 계획은 계정 설정과 최신 출석·급식·세탁 상태를 읽어 notification과 대상별
delivery를 만듭니다. PC는 poll·ack, PWA는 Web Push로 소비합니다. Push 실패는
backoff하고 provider가 `404` 또는 `410`을 반환하면 구독을 폐기합니다.

## 실패와 복구

- 공개 조회는 마지막 정상 snapshot을 유지하고 source health에 실패를 기록합니다.
- collector·출석 알림·급식 알림·세탁 알림·Push·housekeeping은 서로 실패를
  전파하지 않습니다.
- 애플리케이션 readiness는 PostgreSQL 연결과 Spring 상태를 기준으로 합니다.
- 정식 사용자가 없는 동안 스키마 변경은 PostgreSQL volume 재생성으로 처리합니다.
- 2026년 8월 13일 cutover에서는 세탁·급식 기록만 이전했고 일회성 importer는
  배포 코드에서 제거했습니다.

## UI 원칙

PC, PWA, 일반 웹은 shadcn 기반 공통 component를 사용합니다. sidebar는 collapse와
drag resize를 모두 지원하고, Calendar는 React DayPicker를 감싼 shadcn Calendar를
사용합니다. 남성·여성·공용 상태색은 중앙 zone metadata를 기준으로 통일합니다.

라우팅은 모든 플랫폼에서 같은 hash 기반 허용 목록을 사용합니다. 네이티브 기능은
`PlatformAdapter.capabilities`로만 노출하며 브라우저 기본 어댑터가 실수로 호출되면
명시적인 capability 오류를 반환합니다. 서버 응답 대기는 선언적인 Suspense와 Error
Boundary를 우선해 loading·error·empty 상태를 구분합니다.

공통 `app`, `api`, `domain`, `features` 계층은 `@tauri-apps`, 서비스 워커,
`PushManager`를 직접 사용하지 않습니다. Web entry는 PWA 어댑터를, Desktop entry는
단기 HTTP session·IPC·event 어댑터를 구성한 뒤 공통 bootstrap을 호출합니다.

## 관련 문서

- 플랫폼 계약: [reference-platform-contract.md](./reference-platform-contract.md)
- 상태 소유권: [state-management-reference.md](./state-management-reference.md)
- 서버 운영: [../server/OPERATIONS.md](../server/OPERATIONS.md)
- API: [../server/docs/api-reference.md](../server/docs/api-reference.md)
