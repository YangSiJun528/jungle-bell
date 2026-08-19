# Jungle Bell 0.5.0 릴리스 QA 실행 보고서

## 판정

**출시 보류**

실행한 자동 검사, 운영 API 스모크, 퍼블릭 웹 브라우저 검사, 정적 데스크톱 UI 검사는 통과했다. 그러나 실제 PC 앱과 설치형 PWA가 필요한 `P0` 항목을 실행하지 않았으므로 `docs/process-release-qa-0.5.0.md`의 출시 조건은 충족하지 못했다.

실행 범위에서는 Critical 또는 High 결함이 남아 있지 않다. 이 문서에서 `통과`는 실제로 실행한 범위만 뜻하며, 자동 테스트 결과를 실기기 종단 간 통과로 확대 해석하지 않는다.

## 실행 정보

- 제품 버전: `0.5.0`
- 기준 `HEAD`: `9fbb0cbbdf6a4bb44698bc8ed475a3303db83c77`
- 테스트 날짜: `2026-08-19` KST
- 요청 제한 시각: `2026-08-19 19:00` KST
- QA 환경: macOS `26.5.2` (`25F84`)
- 브라우저 캡처 환경: Google Chrome for Testing `149.0.7827.55`
- 데스크톱 UI 논리 크기: `1180 × 780`
- 모바일 웹 논리 크기: `390 × 844`
- 운영 URL: `https://jungle-bell.sijun-yang.com`
- 운영 API 이미지: `sha256:2f30613e78ea8267277d30b4188ecd379cbecc0ee2384feff103dceedf12455b`
- 운영 Worker 이미지: `sha256:0870e1e9dede2a3f29c071281bc67674d94aa01737596d2687db326aaf29b579`
- DB 백업: `/home/ubuntu/backups/jungle-bell/pre-qa-deploy-20260819-1415-b67061e.dump`
- 최신 API 롤백 태그: `jungle-bell-api:rollback-20260819-1545-pre-version-policy`
- 최신 Worker 롤백 태그: `jungle-bell-worker:rollback-20260819-1545-pre-version-policy`
- 테스트 계정과 인증 원문은 기록하지 않았다.

표준 배포 기록은 다음과 같다.

```text
version=0.5.0
gitSha=9fbb0cbbdf6a4bb44698bc8ed475a3303db83c77
apiImage=sha256:2f30613e78ea8267277d30b4188ecd379cbecc0ee2384feff103dceedf12455b
workerImage=sha256:0870e1e9dede2a3f29c071281bc67674d94aa01737596d2687db326aaf29b579
deployedAt=2026-08-19T15:52:03+09:00
dirty=true
```

운영 이미지는 기준 `HEAD`와 미커밋 QA 수정 사항을 포함한 로컬 working tree에서 빌드했다. 따라서 위 이미지 digest가 실제 배포물의 식별자다. 공식 릴리스 전에는 수정 사항을 커밋하고 같은 커밋에서 재현 빌드해야 한다.

제품, Gradle 서버, Vite 프런트엔드, Tauri 데스크톱의 버전을 안정 SemVer `0.5.0`으로 통일했다. 계약 테스트는 이후 버전 업에서 `-SNAPSHOT` 사용과 릴리스 표면 간 불일치를 차단한다.

## 실행 결과 요약

| 범위 | 결과 | 증거 |
| --- | --- | --- |
| 프런트엔드 웹·데스크톱 UI | 통과 | TypeScript, 웹·데스크톱 빌드, Vitest `412/412` |
| 데스크톱 Rust | 통과 | 단위 `186/186`, 통합 `2/2`, `cargo fmt`, Clippy `-D warnings` |
| 서버 | 통과 | Gradle `check`, API·Worker bootJar, 테스트 `59/59` |
| 의존성 보안 | 통과 | `npm audit` 취약점 0, `cargo audit` 취약점 0 |
| React 정적 진단 | 통과 | 전체 `88/100`, 변경 범위 `95/100`; 남은 경고는 의도된 네이티브 동기화·상태 복구 효과로 검토 |
| 운영 배포 | 통과 | PostgreSQL, API, Worker, Tunnel 정상; API health check 통과 |
| 운영 API 스모크 | 통과 | 등록, 단기 WebView session, 개인 API, heartbeat, 악성 Origin 차단, identity 삭제 후 토큰 무효화 |
| 퍼블릭 웹 | 통과 | 운영 브라우저에서 홈·출석·세탁·식단·알림·설정·설치 안내와 직접 hash 진입 확인 |
| 시각 회귀 | 통과 | 최종 PNG 18장 직접 검사, 문서 가로 오버플로 없음, 지연 로딩 이미지 실제 픽셀 확인 |
| 실제 PC 앱 | 미실행 | 요청에 따라 Tauri dev 및 앱 바이너리를 실행하지 않음 |
| 설치형 PWA·Push | 미실행 | 실제 iOS·Android 설치, 연결, 권한, Push 수신 미검증 |
| LMS 종단 간 | 미실행 | 실제 로그인과 오전·오후 출석 변경 미검증 |

자동 테스트는 총 `659`개가 통과했다. 프런트엔드와 데스크톱 전체 검증은 최신 `HEAD`가 추가된 뒤 다시 실행했다. 운영 API 이미지 빌드에서도 웹 빌드와 서버 전체 Gradle 검사를 다시 실행했다.

`cargo audit`의 경고 17건은 Linux GTK3/GLib 계열의 유지보수 상태 알림이며 취약점은 아니다. 현재 릴리스 대상인 macOS와 Windows의 보안 실패로 분류하지 않았다.

## 운영 검증

### 배포와 상태

- 기존 DB를 먼저 백업하고 기존 API·Worker 이미지를 롤백 태그로 보존했다.
- secret 파일은 전송하거나 출력하지 않고 운영 서버의 기존 `.env.production`을 유지했다.
- API와 Worker를 빌드한 첫 배포 후 전체 서비스를 healthy 상태로 전환했다.
- 작업 도중 추가된 `9fbb0cb` 설치 안내 수정은 API 이미지를 다시 빌드해 재배포했다. 이후 버전 정책을 통일하면서 API와 Worker를 모두 안정 버전 `0.5.0` JAR로 재빌드해 배포했다.
- 최종 `/actuator/health/readiness`는 `UP`, `/api/health`는 `OK`였다.
- 세탁, 기본 식단, 고정 식단 수집원의 `consecutiveFailures`는 모두 `0`이었다.
- 최종 배포 후 최근 로그 52줄에서 `ERROR`, `FATAL`, `Exception`, `panic`이 없었다.
- 같은 로그에서 `jbd_`, `jbui_`, Authorization header, Cookie header 원문이 발견되지 않았다.

### 운영 스모크

최종 배포 뒤 다음 결과를 다시 확인했다.

```text
enrollment=201
desktopUiSession=201
attendance=200 missing
mealPreferences=200 lunch+dinner only
laundryWatches=200 empty
mobileSessions=200 empty
heartbeat=200
evilOrigin=403
deletedDesktopToken=401
deletedWebviewToken=401
testAccount=deleted
```

스모크 전후 운영 `app_user`와 `app_session` 건수는 각각 `1/1`로 유지됐다. 테스트 계정과 session은 운영 DB에 남지 않았다.

### 운영 웹

- 인증 없는 홈에서 공개 세탁 요약과 식단이 표시됐다.
- 일반 웹 출석·알림·설정 화면은 개인 데이터 대신 PC 앱 또는 설치형 PWA 안내를 표시했다.
- 퍼블릭 웹의 전체 route 검사 중 `/api/me/*` 요청은 발생하지 않았다.
- `/#/home`, `/#/attendance`, `/#/laundry`, `/#/meals` 직접 진입이 동작했다.
- 잘못된 hash에서는 개인 화면이 열리지 않고 홈 surface가 안전하게 렌더링됐다.
- 최신 설치 안내 화면의 PC 버튼은 README 설치 절차로 연결되고, 데스크톱의 모바일 설치 버튼은 비활성화됐다.
- 설치 안내 화면의 `scrollWidth`는 `clientWidth`를 넘지 않았다.

## 수정한 결함

### PC identity 초기화의 서버 데이터 잔존

기존 초기화는 로컬 PC identity를 먼저 지울 수 있어 서버 계정과 연결된 모바일 session이 남을 수 있었다. 다음과 같이 수정했다.

- 데스크톱 bearer 전용 `DELETE /api/desktop/installations/current`를 추가했다.
- PC session, WebView session, 모바일 session, Push 구독, 설정, watch, 알림 등 계정 종속 데이터를 DB cascade로 삭제한다.
- 서버 삭제가 실패하면 로컬 credential과 installation ID를 보존해 재시도할 수 있게 했다.
- credential이 이미 사라진 복구 상태에서는 새 identity 등록을 허용하되, 이전 모바일 정리가 필요할 수 있음을 UI에 알린다.
- 모바일 bearer로 이 endpoint를 호출하면 거부되고, 삭제 전 유효했던 모바일 cookie도 삭제 후 `401`이 되는 통합 테스트를 추가했다.

credential이 이미 없는 상태에서는 이전 서버 계정을 인증해 삭제할 수 없다. 이 경우는 자동 정리가 불가능한 알려진 제한이며 운영자 정리 또는 기존 모바일 session 만료가 필요하다.

### 운영 스모크의 정리·비밀정보 경계

- 테스트 계정 정리를 로컬 Docker DB 직접 조작이 아니라 인증된 삭제 API로 변경했다.
- 성공과 실패 모두에서 임시 계정 정리를 시도하는 trap을 추가했다.
- curl 실패 시 명령행과 bearer를 출력하지 않도록 요청 함수를 변경했다.
- 삭제된 Desktop·WebView token이 실제로 `401`이 되는지 확인한다.

### 계약 문서

- identity 삭제 endpoint와 실패 동작을 API 문서에 추가했다.
- 잘못 기록돼 있던 모바일 경로와 모바일 session TTL을 현재 계약에 맞게 수정했다.
- 운영 스모크가 테스트 데이터를 자동 정리한다는 점을 운영·배포 문서에 기록했다.

## 체크리스트 판정 근거

### 실행 범위에서 통과

- `WEB-001`~`WEB-006`, `WEB-010`~`WEB-012`: 실제 운영 브라우저와 resource 요청으로 확인했다.
- `REN-007`, `MEAL-001`~`MEAL-003`: 운영 공개 데이터와 이미지 표시를 확인했다.
- `PC-005`, `PC-006`, `PC-024`: 자동·통합 테스트는 통과했다. 실제 앱 종단 간 항목으로는 아직 미실행이다.
- `CONN-003`, `CONN-004`, `CONN-007`: 서버 보안 통합 테스트와 운영 Origin 스모크가 통과했다.
- `COMMON-001`~`COMMON-003`: capability·인증·로그 경계의 자동 검사와 운영 로그 검사가 통과했다.
- `COMMON-007`, `COMMON-012`, `COMMON-013`: 운영 화면, 새 asset 배포, 서비스 상태 endpoint를 확인했다.

### 출시를 막는 미실행 범위

- 새 설치·전환: `REN-001`~`REN-004`, macOS·Windows 실제 설치와 이전 상태 전환
- PC 네이티브: `PC-001`~`PC-004`, `PC-007`~`PC-015`, 자동 시작, 업데이트, 트레이, OS 테마, 절전·네트워크 복구
- 설치형 PWA: `PWA-001`~`PWA-018`, iOS·Android 실제 설치와 다중 모바일
- 출석 종단 간: `ATT-001`~`ATT-007`, 실제 LMS 로그인·오전·오후 상태 변경·날짜 경계
- 알림 종단 간: `NOTI-001`~`NOTI-009`, `NOTI-015`~`NOTI-019`, 실제 PC 알림과 Web Push fan-out·ack·재시도
- 수집원 대조: `LAUN-001`, 실제 원본 source와 표시값의 시점별 대조
- 최종 회귀: macOS·Windows 앱, iOS·Android PWA, 절전·재개, 네트워크 단절·복구

자동 테스트가 있는 항목도 위 종단 간 조건을 대체하지 않는다. 따라서 체크리스트의 `모든 P0 실행`과 `모든 P0 통과`는 체크할 수 없다.

## 시각 QA 증거

캡처 디렉터리:

```text
/tmp/jungle-bell/20260819-144558-b67061e
```

이 디렉터리에는 PNG 18장과 `metrics.json`만 남겼다. 임시 정적 서버, 캡처 script, 테스트 결과 디렉터리는 제거했다.

- 데스크톱 UI는 현재 API schema에 맞는 명시적 시뮬레이션 개인 데이터와 운영 공개 데이터를 사용했다.
- 모바일 화면은 운영 서버의 실제 공개 데이터를 사용했다.
- 전체 페이지 캡처 전 위에서 아래까지 스크롤해 lazy image를 로드하고 모든 `img`의 `complete`와 `naturalWidth > 0`을 확인했다.
- 모바일 첫 화면은 고정 하단 탐색을 포함해 실제 viewport로 보존했다.
- 긴 모바일 전체 페이지 증거에서는 캡처 중간 겹침을 피하려고 고정 탐색만 숨겼으며 이 사실을 `metrics.json`에 기록했다.
- 최종 18장을 직접 열어 오른쪽·아래쪽 잘림, 텍스트 겹침, 이미지 실패를 확인했다.

## 공식 릴리스 전 필수 작업

1. macOS와 Windows 설치본으로 새 설치, LMS 로그인, 출석 동기화, 트레이, 자동 시작, 업데이트, 시스템 알림을 실행한다.
2. iOS와 Android 설치형 PWA에서 수동 코드·QR 연결, 재실행, 연결 해제, 출석 조회, 실제 Web Push를 실행한다.
3. 실제 Jungle Campus에서 오전·오후 미완료와 완료 상태를 전환해 PC → 서버 → PWA 표시를 비교한다.
4. PC 절전·재개, 종료, 네트워크 단절·복구와 Worker 재시작 뒤 출석·알림 복구를 확인한다.
5. 현재 QA 수정 사항을 커밋하고 해당 커밋 SHA에서 운영 이미지를 재현 빌드한다.
6. 공식 배포 기록에 `version`, `gitSha`, API·Worker 이미지 digest, `deployedAt`, `dirty=false`를 함께 남긴다.

## 관련 문서

- [릴리스 QA 체크리스트](process-release-qa-0.5.0.md)
- [플랫폼 계약](reference-platform-contract.md)
- [API 레퍼런스](../server/docs/api-reference.md)
- [서버 운영 가이드](../server/OPERATIONS.md)
- [OCI 운영 배포 가이드](../server/deploy/guide_oci_production_deployment.md)
