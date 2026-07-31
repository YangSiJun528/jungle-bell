# 로컬 개발 환경 실행하기

이 가이드는 API·웹·Tauri를 로컬에서 실행하고, 더미 사용자와 실제
campus source를 자동 검증하는 절차입니다. 실제 LMS 계정 검증은
[LMS 로그인 smoke](guide_lms_login_smoke.md)를 따르십시오.

## 준비 사항

- Node.js 24 이상과 npm
- Rust toolchain과 Tauri 2의 운영체제별 prerequisite
- `smoke:load` 실행 시 k6
- `smoke:container` 실행 시 Docker Engine

## 1. 의존성을 설치합니다

```bash
cd platform
npm ci
```

## 2. API와 웹을 실행합니다

첫 번째 터미널에서 실행합니다.

```bash
cd platform
npm run dev
```

| 대상 | 주소 |
| --- | --- |
| 공개 웹 | `http://127.0.0.1:5173/` |
| 모바일 companion | `http://127.0.0.1:5173/app` |
| API liveness | `http://127.0.0.1:8787/api/health` |
| API readiness | `http://127.0.0.1:8787/api/ready` |

Vite는 `/api`를 API로 proxy합니다. 개발 API는 별도 key가 없으면
process 수명에 한정된 임시 pairing·identity key를 사용합니다. 서버를
재시작하면서 app session과 사용자 연결을 유지해야 할 때는 서로 다른
32바이트 key를 고정합니다.

```bash
openssl rand -base64 32
openssl rand -base64 32
```

출력값을 저장소에 쓰지 말고 현재 개발 shell의
`JB_SESSION_ENCRYPTION_KEY`, `JB_IDENTITY_HMAC_KEY`로 각각 설정한 뒤
API를 실행하십시오. 두 값을 같은 값으로 쓰면 안 됩니다.

기본 개발 server는 `JB_ALLOW_DEV_BOOTSTRAP=true`로 테스트용 desktop
session route를 엽니다. `NODE_ENV=production`에서는 이 route가
등록되지 않습니다. 개발 bootstrap은 실제 LMS 검증 결과로 취급하지
마십시오.

## 3. Tauri를 실행합니다

두 번째 터미널에서 실행합니다.

```bash
cd platform
npm run tauri:dev
```

debug build의 기본 origin은 다음과 같습니다.

| 값 | 기본값 |
| --- | --- |
| main WebView | `http://127.0.0.1:5173` |
| Rust API client | `http://127.0.0.1:8787` |

앱 창은 로컬 HTML이 아니라 Vite의 React 앱을 엽니다. `LMS 로그인`을
누르면 `https://jungle-lms.krafton.com/check-in`을 여는 전용 영구
WebView가 표시됩니다.

다른 origin을 시험할 때는 두 값을 명시합니다.

```bash
JB_APP_ORIGIN=https://bell-dev.example.com \
JB_API_ORIGIN=https://bell-dev.example.com \
npm run tauri:dev
```

release build는 build 시점에 같은 HTTPS origin을 고정해야 합니다.

```bash
JB_APP_ORIGIN=https://bell.example.com \
JB_API_ORIGIN=https://bell.example.com \
npm run tauri:build
```

## 4. 기본 화면을 확인합니다

1. 공개 웹에서 급식과 세탁 카드가 표시되는지 확인합니다.
2. `마지막 확인`과 stale 상태가 화면에 표시되는지 확인합니다.
3. Tauri main 화면에서 LMS 연결 카드와 알림 카드가 표시되는지
   확인합니다.
4. 네트워크를 끊었을 때 과거 화면을 정상 상태처럼 제공하지 않고 오류
   또는 stale로 표시하는지 확인합니다.

로컬 개발에서 campus source를 설정하지 않으면 API는 공개 collector를
시작하지 않습니다. 실제 데이터를 보려면 API 환경에 다음 값을
설정하십시오.

```bash
JB_CAMPUS_DATA_API_URL=https://jungle-bell-api.yangsijun5528.workers.dev
```

## 5. 모바일 연결 UI를 확인합니다

실제 LMS 검증을 마친 Tauri에서 진행합니다.

1. PC에서 모바일 연결 QR과 10자리 코드를 생성합니다.
2. 일반 브라우저에서는 QR URL을 열어 claim합니다.
3. 설치된 PWA 흐름은 `/app`에서 PC의 10자리 코드를 입력해 claim합니다.
4. PC에 표시된 기기명을 확인하고 승인합니다.
5. 모바일이 `/app`의 출석·설정 화면으로 전환되는지 확인합니다.
6. PC의 모바일 기기 목록에서 session을 해제하고 모바일이 다시 연결
   화면으로 돌아가는지 확인합니다.
7. 다시 연결한 뒤 모바일의 `이 휴대폰 연결 해제`도 확인합니다.

실제 휴대폰은 PC의 `127.0.0.1`에 접근할 수 없습니다. 같은-origin HTTPS
개발 배포가 있어야 실제 PWA 설치와 Web Push를 검증할 수 있습니다.

## 6. 전체 정적·단위 검증을 실행합니다

```bash
npm run verify
```

이 명령은 API·웹·Tauri typecheck와 테스트, API·웹 build, Rust
format·Clippy, production origin을 넣은 release check를 실행합니다.
외부 LMS, 실제 Push provider, OCI host는 포함하지 않습니다.

## 7. 200명 플랫폼 smoke를 실행합니다

```bash
npm run smoke:platform
```

script가 격리된 임시 SQLite와 200명의 더미 desktop·mobile session을
만들고 다음 경계를 확인한 뒤 정리합니다.

- desktop heartbeat와 출석 snapshot upload
- desktop·mobile dashboard의 사용자 격리
- 결정적인 fake campus 급식·세탁·이력
- HTTP pairing과 Push subscription 등록·해제

가짜 Push subscription을 저장했다가 해제하는 검증이며 실제 Push
provider에 알림을 전달하지 않습니다.

## 8. k6 부하 smoke를 실행합니다

```bash
npm run smoke:load
```

`smoke:platform` 시나리오 뒤 k6가 200개 desktop 동기화, 200개 mobile
조회, 공개 API 일정 부하를 실행합니다. 더미 사용자만 사용하며 실제 LMS
계정이나 운영 DB를 읽지 않습니다.

로컬 수치는 회귀 탐지용입니다. OCI 용량 보장이나 실제 LMS 처리량으로
해석하지 마십시오.

## 9. 실제 campus source를 확인합니다

인터넷 접근이 가능한 환경에서 실행합니다.

```bash
npm run smoke:campus-live
```

이 smoke는 운영 source의 `/v1/laundry/latest`, `/v1/meals`,
`/v1/meals/history` 응답을 현재 schema로 검증합니다. 외부 서비스
상태에 따라 실패할 수 있으므로 deterministic `smoke:platform`과 구분해
기록하십시오.

## 10. production container를 확인합니다

```bash
npm run smoke:container
```

script가 image를 build하고 임시 Docker volume에서 다음 항목을
확인합니다.

- production secret·VAPID 구성
- production에서 개발 bootstrap route 미등록
- health와 SQLite write
- 정상 종료와 재시작 뒤 desktop session·heartbeat·출석 영속성

실제 OCI bind mount 권한, Caddy, DNS, TLS는
[OCI 배포 가이드](guide_oci_deployment.md)에서 별도로 확인합니다.

## 11. SQLite online backup을 확인합니다

API build 결과가 있어야 합니다.

```bash
npm run build -w @jungle-bell/api
JB_DB_PATH="$PWD/.data/jungle-bell.sqlite" \
JB_BACKUP_DIRECTORY="$PWD/.data/backups" \
npm run db:backup -w @jungle-bell/api
```

출력된 snapshot은 `integrity_check`를 통과했고 mode `0600`으로
생성됩니다. 실행 중인 DB, `-wal`, `-shm` 파일을 직접 복사하지
마십시오.

## 오프라인 동작

지원하지 않습니다. Service Worker는 Push 표시, same-origin 알림 클릭,
과거 cache 삭제만 담당하고 fetch를 가로채지 않습니다.
