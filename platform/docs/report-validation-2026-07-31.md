# Jungle Bell Platform 검증 보고서

검증일은 2026년 7월 31일입니다. 이 보고서는 기존 앱과 호환되지 않는
`platform/` 전면 개편 구현을 대상으로 합니다.

## 판정

현재 구현은 단일 OCI VM과 최대 200명 운영을 전제로 한 릴리스 후보입니다.
서버, 웹·PWA, Tauri collector, SQLite 영속화, 모바일 연결, 알림 outbox와
Push 전송 경계는 구현 및 자동 검증을 마쳤습니다.

실제 LMS 계정으로 Google SSO·2단계 인증, 서버 가입, 출석 snapshot 수집,
Tauri 완전 종료 후 두 차례 재시작과 로그인 유지도 확인했습니다. 서버에는
한 사용자, 한 LMS identity, 한 PC만 유지됐고 재시작 뒤에도 활성 앱 세션과
LMS 상태가 `connected`로 갱신됐습니다.

## 자동 검증

| 검증 | 결과 |
| --- | --- |
| `npm run verify` | 통과. 운영 6, API 180, Rust 50, collector 8, Web 169로 총 413개 테스트 |
| TypeScript·Rust 정적 검사 | 통과. typecheck, `cargo fmt`, Clippy `-D warnings`, release check |
| `npm audit --audit-level=high` | 통과. 취약점 0개 |
| `npm run smoke:platform` | 통과. 200명, 808요청, p95 21.29ms |
| `npm run smoke:load` | 통과. 3,007 HTTP 요청, 실패율 0% |
| 데스크톱 API 부하 | p95 158.72ms, p99 182.53ms |
| 모바일 API 부하 | p95 45.65ms, p99 52.34ms |
| 공개 API 부하 | p95 5.62ms, p99 7.80ms |
| `npm run smoke:campus-live` | 통과. 실제 급식·세탁 source, 200명, 808요청 |
| Compose 설정 렌더링 | 통과. 운영 필수 환경변수의 placeholder를 제공해 문법 검증 |
| 비밀값 혼입 검사 | 실제 계정 이메일과 JWT 형태 값이 source·workflow에 없음 |

## 실제 앱 검증

- 기존 전용 WebView 프로필의 LMS 세션으로 서버 재검증에 성공했습니다.
- Tauri를 완전히 종료하고 두 차례 다시 실행해도 시작 패닉 없이
  `PC 연결됨`과 `LMS 연결됨`으로 복구됐습니다.
- 초기 WKWebView URL이 아직 없는 시점에는 URL getter를 호출하지 않으며,
  개인정보 gate가 완료되기 전에 원격 dashboard를 표시하지 않습니다.
- 실제 계정 smoke DB는 `integrity_check=ok`이고 foreign key 위반이
  없습니다.
- access·refresh cookie를 저장하는 서버 table이나 column은 없습니다.
  서버는 가입 때 받은 access cookie를 `/api/v2/me` 검증에 한 번만 쓰고
  폐기합니다.

## 백업 검증

실계정 smoke DB를 `better-sqlite3` online backup으로 복제했습니다.
게시된 backup 디렉터리에는 권한 `0600`, hard link 수 1인 `.sqlite`
파일 하나만 남았습니다. WAL·SHM sidecar는 없고
`journal_mode=delete`, `integrity_check=ok`, foreign key 위반 0건을
확인했습니다.

## 운영 환경에서 남은 출시 게이트

다음 항목은 구현 누락이 아니라 실제 외부 환경이나 별도 기기가 필요한
출시 검증입니다.

1. 활성 cohort 기간에 실제 `/attendance/today` 조회와 `학습 시작` 클릭
   뒤 재수집을 확인합니다. 현재 실계정 cohort는 시작 전입니다.
2. 운영 HTTPS 도메인에서 실제 iOS·Android 설치형 PWA의 Push 권한,
   수신, 클릭, 구독 만료 복구를 확인합니다.
3. Windows·Linux 빌드에서 네이티브 알림과 tray를 확인합니다.
4. OCI에 Caddy와 단일 app process를 배포하고 장시간 worker soak,
   process 재시작 영속성, off-host backup 복원 drill을 수행합니다.
5. Apple 공증·Windows 서명 credential을 CI secret으로 등록하고 실제
   배포 artifact를 생성합니다.
6. production container smoke는 로컬 Docker daemon이 실행 중이지 않아
   재실행하지 못했습니다. CI의 container job에서 실행해야 합니다.
