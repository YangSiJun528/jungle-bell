# Jungle Bell Platform

Jungle Bell은 공개 급식·세탁 조회, 개인 출석 확인, 생활 알림을 제공하는
서버 중심 서비스입니다. 한 개의 React 앱을 웹과 모바일 PWA에서
사용하고, Tauri 데스크톱 앱은 LMS 로그인·출석 수집·운영체제 알림을
담당합니다.

이 디렉터리는 기존 Jungle Bell과 데이터·구조 호환성을 유지하지 않는
전면 개편 구현입니다.

## 제공 화면

| 환경 | 제공 기능 |
| --- | --- |
| 공개 웹 | 실제 급식·세탁 상태와 마지막 확인 시각 조회 |
| Tauri 데스크톱 | LMS 계정 검증, 출석 동기화, 모바일 연결·해제, 개인 설정, 네이티브 알림 |
| 설치된 모바일 PWA | PC에서 연결한 계정의 출석 조회, 급식·세탁 설정, 자율 대기열, Web Push |

서비스는 온라인 전용입니다. Service Worker는 Web Push만 처리하며 앱
화면이나 API 응답을 오프라인 캐시하지 않습니다.

## 핵심 경계

- 서버는 Fastify와 SQLite로 사용자, 기기, 공개 데이터, 출석 snapshot,
  알림 규칙·outbox를 관리합니다.
- LMS access·refresh cookie의 저장 위치는 각 PC의 전용 Tauri
  WebView입니다.
- PC 등록 때 Tauri가 `access_token` 하나만 서버에 보내면, 서버는
  `/api/v2/me`로 계정을 확인하고 Tauri가 본 계정과의 installation 결합
  증명을 대조합니다. 이후 immutable LMS ID의 HMAC만 저장하고 cookie를
  버립니다. refresh cookie는 PC를 떠나지 않습니다.
- 이후 출석은 Tauri가 로컬에서 읽어 정규화된 snapshot과 heartbeat만
  서버에 보냅니다.
- 동일 LMS 계정을 각 PC에서 독립적으로 다시 검증하면 같은 서버 사용자로
  연결됩니다.
- 모바일은 검증된 PC가 만든 QR 또는 10자리 연결 코드로 연결합니다.

자세한 이유와 데이터 흐름은
[아키텍처 설명](docs/explanation-architecture.md)을 참고하십시오.

## 로컬에서 시작하기

Node.js 24 이상, npm, Rust와 Tauri 2의 운영체제별 prerequisite가
필요합니다.

```bash
cd platform
npm ci
npm run dev
```

공개 웹은 `http://127.0.0.1:5173`, API liveness와 readiness는 각각
`http://127.0.0.1:8787/api/health`,
`http://127.0.0.1:8787/api/ready`에서 확인합니다. Tauri는 별도
터미널에서 실행합니다.

```bash
cd platform
npm run tauri:dev
```

전체 절차는 [로컬 개발 가이드](docs/guide_local_development.md)를
따르십시오.

## 검증 명령

모든 명령은 `platform/`에서 실행합니다.

| 명령 | 검증 범위 |
| --- | --- |
| `npm run verify` | API·웹·Tauri typecheck, 테스트, build, Rust fmt·Clippy·release check |
| `npm run smoke:platform` | 200명 더미 사용자, 출석 동기화, 공개 데이터, 페어링, Push 등록 경계 |
| `npm run smoke:load` | 위 smoke와 k6의 데스크톱·모바일·공개 API 부하 |
| `npm run smoke:campus-live` | 실제 운영 급식·세탁 source 계약 |
| `npm run smoke:container` | production container 설정, health, SQLite 재시작 영속성 |

이 자동화는 Google SSO·2단계 인증이나 실제 Apple·Google Push 전달을
대체하지 않습니다. 두 항목은 운영 HTTPS 환경에서 수동으로 확인합니다.

SQLite online backup은 API를 먼저 build한 뒤 실행합니다.

```bash
npm run build -w @jungle-bell/api
JB_DB_PATH="$PWD/.data/jungle-bell.sqlite" \
JB_BACKUP_DIRECTORY="$PWD/.data/backups" \
npm run db:backup -w @jungle-bell/api
```

## 배포 전제

운영 구성은 OCI VM 한 대, Caddy 한 개, app container 한 개, Node.js
process 한 개, VM 로컬 영속 디스크의 SQLite 한 개입니다. SQLite는 WAL,
`synchronous=FULL`, foreign key, 5초 `busy_timeout`을 사용합니다.

여러 process나 container replica, NFS·공유 volume은 지원하지 않습니다.
이 전제가 바뀌면 PostgreSQL과 분산 worker·rate limit으로 함께
전환해야 합니다.

## 문서

- [아키텍처 설명](docs/explanation-architecture.md)
- [구현·운영 참조](docs/reference-stage-0.md)
- [2026-07-31 검증 보고서](docs/report-validation-2026-07-31.md)
- [로컬 개발 환경 실행](docs/guide_local_development.md)
- [실계정 LMS 로그인 smoke](docs/guide_lms_login_smoke.md)
- [로컬 출석 동기화 smoke](docs/guide_local_attendance_smoke.md)
- [단일 OCI VM 배포](docs/guide_oci_deployment.md)
