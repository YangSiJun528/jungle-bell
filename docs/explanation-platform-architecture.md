# Jungle Bell 플랫폼 아키텍처

## 설계 결론

Jungle Bell은 PC가 Jungle LMS session과 출석 수집을 전담하고, OCI의 Spring 서버가
기기 연결·출석 snapshot·생활 설정·공개 데이터·알림 전달 상태를 관리합니다. 일반
웹, 설치 PWA, Tauri PC 앱은 같은 UI를 사용하지만 권한과 역할은 런타임별로
분리합니다.

기존 서버 세션이나 연결 정보와 호환하지 않습니다. 새 버전에서는 PC 등록과 모바일
연결을 다시 수행합니다. 이전 서버에서 옮기는 데이터는 공개 세탁·급식 기록뿐입니다.

```text
Jungle LMS ─ checker WebView ─ Tauri PC
                               │
                               ├─ 출석 snapshot·heartbeat
                               ├─ 알림 poll·ack
                               └─ 단기 WebView HTTP session bootstrap
                                           │
일반 웹 ─ 공개 HTTP ───────────────┐         │
Tauri UI ─ 공개·desktop-ui HTTP ───┼─ Spring Boot ─ PostgreSQL
설치 PWA ─ mobile cookie·Web Push ─┘         │
                                             ├─ 세탁·급식 수집
                                             ├─ 알림 계획·전송
                                             └─ housekeeping
```

## 서버를 하나로 합친 이유

이전 구조는 HTTP Worker, 원격 SQL/object gateway, 별도 Jobs 런타임에 같은 도메인
규칙이 나뉘어 있었습니다. 새 구조는 Spring MVC controller, service, Spring Data
JDBC repository와 PostgreSQL로 한 경계를 만듭니다.

- API와 background 작업이 같은 domain model과 transaction 경계를 사용합니다.
- 세탁·급식 이미지도 PostgreSQL에 저장해 별도 object gateway를 제거합니다.
- 정적 웹 자산도 같은 OCI 이미지에 포함해 배포 단위를 하나로 줄입니다.
- 수집 실패가 HTTP server를 중단하지 않도록 scheduler 작업별로 실패를 격리합니다.

Cloudflare Tunnel은 필요할 때 OCI localhost 서비스를 외부에 노출하는 ingress일 뿐,
애플리케이션 실행이나 데이터 저장을 담당하지 않습니다.

## 자격 증명 경계

LMS access·refresh cookie는 Tauri의 전용 checker WebView profile에만 존재합니다.
Rust가 원문을 추출하거나 서버로 보내지 않습니다. 제한된 same-origin collector가 LMS
상태와 정규화한 출석 snapshot만 Rust로 전달합니다.

PC가 Spring 서버에 쓰는 자격 증명은 LMS와 무관한 `jbd_` credential입니다. 서버는
hash만 저장합니다. Windows는 원문을 Credential Manager에 보관하고 macOS·Linux는
앱 전용 mode 0600 파일에 저장합니다.

React 대시보드는 장기 credential을 받지 않습니다. Rust가 7분짜리 `jbui_` session을
발급받아 WebView 메모리에만 전달합니다. 이 session은 exact Tauri origin과 부모 PC
session에 묶이고 `/api/desktop-ui/*`만 호출할 수 있습니다. 공개 세탁·급식도 Rust
proxy 없이 React가 직접 HTTP로 조회합니다.

모바일 PWA는 PC에서 명시적으로 승인한 pairing으로만 연결됩니다. pending claim과
모바일 session credential은 Strict HttpOnly cookie에만 저장합니다.

## 상태 소유권

- Tauri PC: LMS session, LMS 로그인 상태, 출석 수집, 네이티브 알림, PC 로컬 설정.
- Spring Boot: HTTP API, 정적 웹, 인증, pairing, 최신 출석 snapshot, 개인 설정,
  알림과 delivery, 공개 데이터 수집·정리·Web Push.
- PostgreSQL: session hash, 설정, 공개 세탁·급식 기록과 이미지, 알림 상태.
- 일반 웹: 공개 세탁·급식 조회와 설치 안내.
- 설치 PWA: 동기화된 출석·D-Day, 생활 설정, 연결 관리와 Web Push.

서버는 PC를 원격 조작하지 않습니다. 데스크톱 inbox에는 표시할 알림 delivery만
들어가며 LMS 요청이나 세탁 조작 명령을 넣지 않습니다.

출석·급식 알림 설정은 PostgreSQL의 계정 설정으로 저장해 PC와 PWA가 공유합니다.
자동 시작·자동 업데이트·사용 통계·디버그·로그 폴더는 해당 PC에만 영향을 주므로
로컬 설정과 제한된 Tauri IPC가 소유합니다.

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

라우팅은 hash 기반 허용 목록을 사용하고 runtime surface가 허용하지 않는 개인 화면은
렌더하지 않습니다. 서버 응답 대기는 선언적인 Suspense와 Error Boundary를 우선해
loading·error·empty 상태를 구분합니다.

## 관련 문서

- 플랫폼 계약: [reference-platform-contract.md](./reference-platform-contract.md)
- 상태 소유권: [state-management-reference.md](./state-management-reference.md)
- 서버 운영: [../server/OPERATIONS.md](../server/OPERATIONS.md)
- API: [../server/docs/api-reference.md](../server/docs/api-reference.md)
