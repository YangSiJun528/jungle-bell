# 사용 통계 QA 절차

## 목적

사용 통계의 수집 gate, 식별 단위, 릴리스 전송 경계, API 기록, Worker 집계와 보존기간을
서로 분리해 검증합니다. HTTP `204`나 Worker 성공 하나만으로 실제 수집을 판정하지
않습니다.

## 사용 방법

- `[ ]`: 미실행
- `[x]`: 통과
- 실패한 항목은 체크하지 않고 `FAIL — 이슈 링크`를 기록합니다.
- 차단된 항목은 체크하지 않고 `BLOCKED — 사유`를 기록합니다.
- `P0` 실패 또는 차단이 하나라도 있으면 릴리스하지 않습니다.
- token, cookie 원문, 서버 계정 UUID, installation identity, 익명 HMAC을 QA 문서나
  로그 발췌에 남기지 않습니다.
- 날짜 조작, 과거 원자료 삽입과 수동 삭제는 폐기 가능한 로컬·QA PostgreSQL에서만
  수행합니다. 운영 DB에서는 aggregate 조회만 합니다.

## 실행 정보

- 앱 버전:
- 커밋 SHA:
- 서버 배포 SHA:
- 테스트 기간:
- QA 담당자:
- Web 브라우저·버전:
- PWA OS·브라우저:
- Desktop OS·앱 channel:
- API·Worker의 `USAGE_METRICS_ENABLED`:
- 관련 이슈:

## 1. 자동 검사

Frontend 회귀 테스트와 정적 검사를 실행합니다.

```bash
npm --prefix frontend test -- \
  src/app/privacy-page.test.tsx \
  src/platform/web/usage-preference.test.ts \
  src/platform/web/usage-reporting.test.ts \
  src/features/connections/service-settings.test.tsx
npm --prefix frontend run format:check
npm --prefix frontend run lint
npm --prefix frontend run typecheck
```

Desktop preference, 동시성, 재시도와 release guard 테스트를 실행합니다.

```bash
JUNGLE_BELL_DATA_API_URL=https://jungle-bell.sijun-yang.com \
  cargo test --manifest-path desktop/Cargo.toml --all-targets usage
JUNGLE_BELL_DATA_API_URL=https://jungle-bell.sijun-yang.com \
  cargo test --manifest-path desktop/Cargo.toml --all-targets \
  pc_사용_통계는_release_빌드에서만_전송한다
```

서버 기록, preference, API 응답, 집계와 보존기간 테스트를 실행합니다.

```bash
cd server
./gradlew :core:test \
  --tests 'app.junglebell.server.domain.usage.UsageRecorderTest' \
  --tests 'app.junglebell.server.domain.usage.UsageAggregationServiceTest' \
  --tests 'app.junglebell.server.domain.usage.JdbcUsageStoreIntegrationTest'
./gradlew :api:test \
  --tests 'app.junglebell.server.api.usage.UsageControllerTest' \
  --tests 'app.junglebell.server.api.usage.UsageInfoContributorTest' \
  --tests 'app.junglebell.server.api.security.SecurityFilterChainIntegrationTest'
```

- [ ] **AUTO-001 [P0] Frontend** — 대상 테스트, format, lint, typecheck가 모두 통과합니다.
- [ ] **AUTO-002 [P0] Desktop** — nullable migration, OFF 우선, ON 확인, 제한 재시도,
  release guard 테스트가 통과합니다.
- [ ] **AUTO-003 [P0] Server** — `null`·`false` gate, `204`·`503`, 허용 기능 코드,
  집계·purge와 공개 상태 테스트가 통과합니다.

## 2. 식별 단위와 수치 해석

| 표시·저장 단위 | 올바른 해석 | 금지하는 해석 |
| --- | --- | --- |
| 인증 `unique_subjects` | 해당 날짜에 활동한 distinct 서버 계정 UUID 수 | 실제 사람 수, 물리 PC 수 |
| PC installation identity | PC 앱이 만든 무작위 UUID v4 기반 설치 등록 단위 | 하드웨어 ID, 한 사람의 영구 ID |
| 익명 `unique_subjects` | 해당 날짜의 distinct HMAC 방문자 수 | 날짜를 넘는 고유 방문자 또는 사람 수 |

- [ ] **ID-001 [P0] 원자료 키** — 인증 사용 통계 테이블은 서버 계정 `user_id`를
  저장하고 installation identity를 사용 통계 열로 저장하지 않습니다.
- [ ] **ID-002 [P0] 등록 관계** — PC 앱은 무작위 installation identity로 서버 계정을
  등록하고 연결 PWA는 같은 서버 계정을 공유합니다.
- [ ] **ID-003 [P0] 보고서 표현** — 인증 수치는 “활성 서버 계정”, PC 등록 수치는
  “PC installation identity”로 표시하며 “사용자 수” 또는 “사람 수”로 바꾸지 않습니다.
- [ ] **ID-004 [P0] 합산 금지** — 인증 계정 수와 익명 방문자 수를 더해 전체 고유
  사용자나 사람 수를 만들지 않습니다.

## 3. 계정 preference와 migration

| 입력 | 저장 상태 | 유효 동작 |
| --- | --- | --- |
| 계정 행 없음 또는 `enabled=null` 응답 | pending | OFF |
| `enabled=false` | 명시적 거부 | OFF |
| `enabled=true` | 명시적 허용 | ON |
| Desktop v3 `usageAnalytics=false` | v5 `false` | 기존 거부 승계 |
| Desktop v3 `usageAnalytics=true` | v5 `null` | 과거 기본값이므로 pending/OFF |
| Desktop v4 | v5 `null` | 선택 복원 불가, pending/OFF |
| 설정 파일 없음 + 새 identity + 새 등록 | v5 `true` | 완전 신규 설치만 기본 ON |
| invalid·unreadable 설정 | 런타임 `false` | fail-closed |

- [ ] **PREF-001 [P0] pending** — PC 설정 스위치는 OFF로 보이고 계정 UI 열림·기능
  원자료가 생기지 않습니다.
- [ ] **PREF-002 [P0] 명시적 OFF** — PC 전송은 즉시 중단되고, 서버 동기화가 끝난 뒤
  연결 PWA의 인증 활동과 기능도 기록되지 않습니다.
- [ ] **PREF-003 [P0] 명시적 ON** — PC는 로컬 저장만으로 전송하지 않고 서버가 같은
  값을 확인한 뒤에만 전송합니다.
- [ ] **PREF-004 [P1] 동기화 상태** — 서버 동기화가 pending이면 PC 설정 화면에
  pending 문구가 보이며 계정 전체에 적용된 것처럼 확정 표시하지 않습니다.
- [ ] **PREF-005 [P0] 유일한 편집자** — PC bearer의
  `PUT /api/desktop/usage-preference`는 성공하고, 연결 PWA의
  `PUT /api/me/usage-preference`는 `403`입니다.
- [ ] **PREF-006 [P0] PWA gate** — 연결 PWA는 `/api/me/usage/ui-opened`를 사용하며
  계정이 pending 또는 OFF일 때 받은 `204`를 익명 endpoint로 fallback하지 않습니다.
- [ ] **PREF-007 [P0] migration** — 위 표의 v3·v4·신규·손상 설정 결과가 Desktop
  설정 파일과 서버 preference에 그대로 반영됩니다.

## 4. 익명 Web·미연결 PWA opt-out

- [ ] **ANON-001 [P0] 기본 범위** — 일반 Web과 미연결 PWA만 익명 preference를
  사용하고 연결 PWA의 계정 기록에는 적용하지 않습니다.
- [ ] **ANON-002 [P0] 기본 허용** — site data가 없는 브라우저에서
  `GET /api/public/usage-preference`가 `enabled=true`를 반환합니다.
- [ ] **ANON-003 [P0] 거부 저장** — OFF 후 로컬 저장소에
  `jungle-bell:anonymous-usage:v1=disabled`가 남고, HTTPS에서는 최대 1년의
  `__Host-jb_usage_opt_out` HttpOnly·Secure·SameSite=Strict cookie가 생깁니다.
- [ ] **ANON-004 [P0] 즉시 차단** — OFF 변경은 서버 PUT보다 먼저 로컬 gate를 닫고,
  기존 24시간 `__Host-jb_usage` 방문자 cookie를 만료합니다.
- [ ] **ANON-005 [P0] 거부 중 수집 없음** — OFF 상태의
  `POST /api/public/usage/ui-opened`는 `204`지만 익명 원자료 aggregate는 늘지 않습니다.
- [ ] **ANON-006 [P1] 다시 허용** — ON 저장이 서버에서 성공한 뒤에만 로컬 거부값과
  opt-out cookie가 제거됩니다.
- [ ] **ANON-007 [P1] site data 삭제** — 브라우저 site data를 삭제하면 별도 계정
  설정에는 영향 없이 익명 기본 허용으로 돌아갑니다.

## 5. production·release 전송 경계와 재시도

- [ ] **BUILD-001 [P0] Web 개발 빌드** — 개발 Web/PWA에서 화면을 열거나 visibility를
  바꿔도 자동 UI 열림 endpoint를 호출하지 않습니다.
- [ ] **BUILD-002 [P0] Desktop debug** — debug PC 앱에서 창을 열어도
  `[usage] UI open metric skipped in a debug build`만 남고 UI 열림 endpoint를 호출하지
  않습니다.
- [ ] **BUILD-003 [P0] 공식 빌드** — Web·PWA production 빌드와 Desktop release
  빌드에서만 해당 preference가 허용한 자동 UI 열림 요청이 발생합니다.
- [ ] **BUILD-004 [P0] 기능 메트릭 예외** — 기능 메트릭은 서버 내부 기록이라 client
  build를 판별하지 못함을 확인합니다. 개발 client로 실제 업무 API를 시험할 때는 운영
  계정 preference를 ON으로 두지 않거나 폐기 가능한 QA 계정을 사용합니다.
- [ ] **RETRY-001 [P0] 재시도 대상** — 네트워크 오류와 `502`·`503`·`504`만 최초
  요청을 포함해 최대 세 번 시도합니다.
- [ ] **RETRY-002 [P0] 재시도 제외** — `400`·`401`·`403`·`500`은 재시도하지 않고,
  설치 PWA의 익명 fallback은 인증 endpoint의 정확한 `401`에서만 수행합니다.
- [ ] **RETRY-003 [P0] 취소 우선** — 화면 숨김, reporter 중지, 통계 OFF, Desktop
  identity 변경이 발생하면 대기 중인 다음 재시도보다 먼저 반영됩니다.

## 6. API `204`와 원자료 기록

먼저 [서버 운영 절차의 사용량 수집과 집계 확인](../server/OPERATIONS.md#사용량-수집과-집계-확인)에
있는 식별자 없는 inventory와 원자료 aggregate를 저장합니다. 공식 릴리스 client에서
각 시나리오를 실행한 뒤 같은 조회를 반복합니다.

- [ ] **RAW-001 [P0] 신규 기록** — ON 계정 또는 허용된 익명 브라우저가 그날 처음
  UI를 열면 `204`이고 해당 audience·client의 원자료 aggregate가 한 행 늘어납니다.
- [ ] **RAW-002 [P0] 일일 중복** — 같은 주체·날짜·client가 다시 열면 `204`지만
  원자료 행 수는 늘지 않습니다.
- [ ] **RAW-003 [P0] 정책 생략** — 계정 pending·OFF 또는 익명 opt-out에서도 `204`지만
  원자료 행 수는 늘지 않습니다.
- [ ] **RAW-004 [P0] 전역 비활성화** — 폐기 가능한 QA 환경에서
  `USAGE_METRICS_ENABLED=false`이면 `204`지만 신규 원자료가 없습니다.
- [ ] **RAW-005 [P0] 일시 장애** — fault injection 단위 테스트 또는 폐기 가능한 QA
  DB에서 복구 가능한 저장 장애는 `503`, `Retry-After: 1`,
  `{"error":"USAGE_METRICS_UNAVAILABLE"}`를 반환합니다. 운영 DB를 중단하지 않습니다.
- [ ] **RAW-006 [P0] 예상 밖 장애** — 예상하지 못한 오류는 `500`이며 `204`로
  숨기지 않습니다.
- [ ] **RAW-007 [P1] 기능 성공 경계** — 허용 목록의 업무 동작이 실제 성공한 뒤에만
  기능 `use_count`가 증가하고 실패·거부된 동작은 증가시키지 않습니다.

`204`는 신규 INSERT, 중복, 정책 생략을 구분하지 않으며 Worker 접수나 집계 완료를
의미하지 않습니다. 위 항목은 반드시 응답과 원자료 aggregate를 함께 확인합니다.

## 7. Worker 집계와 운영 상태

- [ ] **AGG-001 [P0] 내부 API 상태** — Tailscale SSH 후 호스트 loopback
  `/actuator/info`의 `usageMetrics`에
  `configured`, `database`, `aggregation`과 조건부 `lastSuccessfulAggregationAt`만
  나오고 수치·UUID·HMAC·원자료 최근 시각은 나오지 않습니다.
- [ ] **AGG-002 [P0] 실행 분리** — API가 원자료를 기록하고 Worker는 원자료 ingestion
  없이 요약 재집계와 purge만 수행합니다.
- [ ] **AGG-003 [P0] 전체 성공 marker** — `usage-daily-summary-v1:success`는 대상
  scope 재집계와 네 테이블 purge가 모두 끝난 뒤에만 갱신됩니다.
- [ ] **AGG-004 [P1] 상태 판정** — 마지막 성공이 없으면 `never`, 130분 이내면
  `fresh`, 130분을 넘으면 `stale`, marker 조회 실패면 `unavailable`입니다.
- [ ] **AGG-005 [P0] 원자료 대조** — Worker 완료 뒤 요약의 `unique_subjects`와
  `total_count`가 같은 날짜·audience·client·code의 원자료 aggregate와 일치합니다.
- [ ] **AGG-006 [P1] 전역 OFF** — 전역 OFF에서는 재집계를 생략하되 purge와 성공
  marker 갱신은 계속합니다.
- [ ] **AGG-007 [P0] 관리 경계** — 공식 origin과 API port의 `/actuator`,
  `/actuator/health/readiness`, `/actuator/info`는 모두 `404`이고, 호스트 loopback
  관리 port에서만 health와 info가 `200`입니다. 관리 port는 Docker host의
  `127.0.0.1`에만 publish하고 외부 interface나 Cloudflare Tunnel에는 연결하지 않습니다.

## 8. 보존과 삭제

| 데이터 | Worker cutoff |
| --- | --- |
| 익명 화면 활동 원자료 | 2일 |
| 인증 계정 화면 활동 원자료 | 7일 |
| 인증 계정 기능 원자료 | 30일 |
| 개인 식별자가 없는 일별 요약 | 730일 |

- [ ] **RET-001 [P0] 경계 조건** — 폐기 가능한 QA DB에서
  `usage_date < 오늘 - 보존일수`인 행만 삭제되고 cutoff 날짜 행은 남습니다.
- [ ] **RET-002 [P0] scope 분리** — 7일이 지난 날짜의 인증 활동 원자료가 없어도
  30일 범위의 기능 원자료와 기존 활동 요약을 훼손하지 않습니다.
- [ ] **RET-003 [P0] opt-out의 미래 적용** — preference OFF는 이후 기록만 막고 기존
  원자료를 즉시 삭제하지 않습니다. 기존 원자료는 2일·7일·30일 purge까지 남습니다.
- [ ] **RET-004 [P0] 요약 역삭제 금지** — preference OFF만으로 개인 식별자가 없는
  기존 요약을 역삭제하지 않습니다.
- [ ] **RET-005 [P0] 계정 삭제 구분** — 계정 삭제는 인증 원자료를 foreign key
  cascade로 삭제하고, 아직 원자료 보존 범위인 최근 요약은 다음 재집계에서 조정될 수
  있습니다. preference OFF와 같은 동작으로 설명하지 않습니다.
- [ ] **RET-006 [P1] SLA 해석 금지** — 2일·7일·30일·730일은 Worker 삭제 cutoff이며
  해당 기간 동안 데이터가 반드시 존재한다는 가용성 보장으로 문서화하지 않습니다.

## 9. 사용자 고지

- [ ] **NOTICE-001 [P0] 버전** — 개인정보 처리방침 버전 `1.2`와 시행일이 표시됩니다.
- [ ] **NOTICE-002 [P0] 사람 수 해석 금지** — PC 앱이 무작위 installation identity로
  서버 계정을 등록하고 통계는 서버 계정 UUID를 세며, 실제 사람 수가 아님을 고지합니다.
- [ ] **NOTICE-003 [P0] 계정 경로** — 계정 설정은 PC 앱의 **설정 → 개인정보**에서만
  바꾸고 연결 PWA에 같은 gate가 적용된다고 안내합니다.
- [ ] **NOTICE-004 [P0] 기존·신규 정책** — 과거 명시적 거부 유지, 선택을 복원할 수
  없는 기존 설치는 선택 전까지 OFF, 완전 신규 설치만 기본 ON임을 안내합니다.
- [ ] **NOTICE-005 [P0] 익명 범위** — 일반 Web·미연결 PWA의 익명 opt-out이 계정
  설정과 별도임을 안내합니다.
- [ ] **NOTICE-006 [P0] 기존 데이터** — opt-out 뒤 기존 원자료는 보존기간 만료 시
  삭제하고 비식별 일별 요약은 preference 변경으로 역삭제하지 않음을 안내합니다.

## 완료 조건

- [ ] 모든 `P0` 항목을 실행했습니다.
- [ ] 모든 `P0` 항목이 통과했습니다.
- [ ] `P1` 실패의 영향과 후속 이슈를 기록했습니다.
- [ ] 응답, 원자료 aggregate, Worker 상태를 함께 확인했습니다.
- [ ] 어떤 통계 수치도 실제 사람 수로 보고하지 않았습니다.
- [ ] secret 또는 원문 식별자가 QA 산출물에 포함되지 않았습니다.

## 관련 문서

- [플랫폼 계약 레퍼런스](./reference-platform-contract.md)
- [상태 관리 레퍼런스](./state-management-reference.md)
- [플랫폼 아키텍처 설명](./explanation-platform-architecture.md)
- [서버 사용량 메트릭 레퍼런스](../server/docs/usage-metrics-reference.md)
- [서버 운영 절차](../server/OPERATIONS.md#사용량-수집과-집계-확인)
