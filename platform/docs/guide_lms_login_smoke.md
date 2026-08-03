# 실계정 LMS 로그인 smoke 실행하기

이 가이드는 한 명의 실제 계정으로 Google SSO·2단계 인증, 서버 사용자
식별, 앱 재시작, 다중 PC 연결을 수동 확인합니다. 계정 입력과 2단계
인증은 자동화하지 않습니다.

출석 값과 access JWT 갱신의 장시간 확인은
[로컬 출석 동기화 smoke](guide_local_attendance_smoke.md)를 함께
수행하십시오.

## 검증할 불변 조건

- `/api/v2/me.id`만 LMS 외부 계정 식별자로 사용
- Tauri가 서버에 보내는 LMS cookie는 유효한 `access_token` 하나뿐임
- refresh cookie는 Tauri WebView를 떠나지 않음
- 서버가 LMS ID 원문과 LMS cookie를 영속 저장하지 않음
- 서버가 검증한 LMS ID의 정확한 SHA-256으로 동일 사용자를 판별함
- 서버 사용자 기본키는 별도 RFC 4122 v4 UUID임
- 동일 LMS 계정은 PC가 달라도 같은 내부 사용자 UUID에 연결됨
- 각 PC는 기존 PC 승인 없이 독립적으로 LMS를 다시 검증함
- 앱 재시작 뒤 현재 LMS subject가 로컬 binding과 일치해야 개인 기능이
  다시 활성화됨

## 준비 사항

- 실제 Jungle LMS 계정 한 개
- Google 2단계 인증을 완료할 사용자 기기
- Node.js, Rust, Tauri 개발 환경
- `platform/`에서 `npm ci` 완료
- API·웹용 터미널과 Tauri용 터미널

실제 출석을 변경하는 API를 호출하지 않습니다. 로그인과 조회만
수행합니다.

## 1. API와 웹을 실행합니다

첫 번째 터미널:

```bash
cd platform
npm run dev
```

health를 확인합니다.

```bash
curl --fail http://127.0.0.1:8787/api/health
```

## 2. Tauri를 실행합니다

두 번째 터미널:

```bash
cd platform
npm run tauri:dev
```

main 창에는 먼저 `LMS 계정을 확인하고 있습니다` 개인정보 보호 화면만
표시되어야 합니다. 저장된 LMS session이 없으면 전용 로그인 창이
자동으로 열립니다. 자동으로 열리지 않으면 tray의 `LMS 로그인 열기`를
선택합니다. 이 단계에서 재시작 전 원격 dashboard가 잠깐이라도 보이면
실패입니다.

## 3. 첫 PC를 등록합니다

1. 자동으로 열린 전용 로그인 창을 사용합니다. 창을 닫았다면 tray의
   `LMS 로그인 열기`를 선택합니다.
2. Google SSO와 2단계 인증을 사용자가 직접
   완료합니다.
3. Jungle LMS로 돌아온 뒤 로그인 창이 숨겨지고 main 화면이
   `LMS 연결됨`으로 바뀔 때까지 기다립니다.
4. 출석 카드에 실제 cohort와 오전·오후 상태가 표시되는지 확인합니다.
5. 모바일 QR·연결 코드 생성 버튼이 활성화되는지 확인합니다.

로그인 완료는 화면 문구나 email이 아니라 LMS `/api/v2/me`의 유효한
응답으로 판정합니다.

## 4. 서버 무보관을 확인합니다

DB에서는 민감 값 대신 schema와 count만 확인합니다.

```bash
sqlite3 -readonly .data/jungle-bell.sqlite \
  "SELECT
     (SELECT COUNT(*) FROM users) AS users,
     (SELECT COUNT(*) FROM external_identities) AS identities,
     (SELECT COUNT(*) FROM desktop_devices) AS desktops,
     (SELECT COUNT(*) FROM desktop_sessions) AS desktop_sessions,
     (SELECT MIN(length(subject_sha256)) FROM external_identities) AS sha256_length,
     (SELECT MIN(hash_version) FROM external_identities) AS hash_version;"
```

첫 등록이면 각 count는 최소 1이고 SHA-256 길이는 64, hash version은
1이어야 합니다. `users.id`가 RFC 4122 v4 UUID인지도 민감 값을 출력하지
않는 검증 script나 자동 테스트로 확인합니다. LMS credential table이
없는지도 확인합니다.

```bash
sqlite3 -readonly .data/jungle-bell.sqlite \
  "SELECT COUNT(*) FROM sqlite_schema
   WHERE type='table'
     AND name IN ('lms_sessions','lms_cookies','attendance_collector_runs');"
```

결과는 `0`이어야 합니다. LMS ID, cookie, token 원문을 shell·SQL·로그에
넣지 마십시오.

API logger에서는 `Cookie`, `Authorization`, `Set-Cookie`가
redaction됩니다. onboarding 요청이 정확히 access cookie 하나가 아니면
서버가 거부하므로 refresh cookie를 전달하는 우회 경로를 만들지
마십시오. 이 access cookie는 서버가 `/api/v2/me`를 한 번 호출하는 동안만
사용하며 DB, 오류 객체, 응답에 보존되지 않아야 합니다.

## 5. 앱 재시작을 확인합니다

1. tray의 `종료`로 Tauri를 완전히 종료합니다.
2. 같은 명령으로 Tauri를 다시 실행합니다.
3. 사용자가 다시 로그인하지 않아도 기존 WebView LMS session이
   복원되는지 확인합니다.
4. 확인이 끝나기 전에는 메인 창이 원격 dashboard 대신 `LMS 계정을
   확인하고 있습니다` 개인정보 보호 화면만 표시하는지 확인합니다.
5. 현재 `/api/v2/me.id`가 로컬 subject binding과 일치하고 서버
   onboarding 재검증이 끝난 뒤
   `LMS 연결됨`과 출석 동기화가 다시 활성화되는지 확인합니다.
6. 출석 마지막 동기화 시각이 갱신되는지 확인합니다.

로컬 app data에는 LMS ID 원문 대신 installation별 SHA-256 digest가
`lms-subject-binding`에 저장됩니다. 파일의 내용을 출력하지 말고 일반
파일이고 크기가 64바이트인지 metadata만 확인하십시오. Keychain은
사용하지 않습니다.

현재 subject가 확인되기 전에도 재시작 전 app session과 로컬 binding이
있으면 heartbeat는 `unknown` 또는 `login-required`를 보고하고 generic
`login-required` native 알림은 표시할 수 있습니다. 원격 dashboard와
출석 snapshot은 사용하지 않아야 합니다. 급식·세탁·출석 알림은
표시하거나 ACK하지 않으며, lease 만료와 subject 확인 뒤 다시
전달되어야 합니다.

## 6. 같은 계정의 추가 PC를 확인합니다

다른 실제 PC나 별도 운영체제 사용자 profile을 사용하십시오. 기존 Tauri
app data나 WebView profile을 복사하지 않습니다.

1. 추가 PC에 Jungle Bell을 새로 설치하고 실행합니다.
2. 첫 PC에서 승인하는 절차 없이 `LMS 로그인`을 누릅니다.
3. 첫 PC와 같은 LMS 계정으로 Google SSO·2단계 인증을 완료합니다.
4. DB의 `users`, `external_identities` count는 유지되고
   `desktop_devices`, `desktop_sessions`만 증가하는지 확인합니다.
5. 두 PC의 최신 heartbeat가 모바일 기기 관리와 출석 상태를 망가뜨리지
   않는지 확인합니다.
6. 두 PC 중 `collectedAt`이 더 최신인 출석 snapshot이 공통 사용자
   dashboard에 반영되는지 확인합니다.

추가 PC는 모바일 페어링으로 등록하지 않습니다. LMS 계정을 직접
재검증하는 것이 계정 소유 증명입니다.

## 7. 연동 해제를 확인합니다

한 PC에서 `LMS 연동 해제`를 누릅니다.

- 해당 PC의 app session이 폐기됩니다.
- Tauri main WebView의 app cookie가 제거됩니다.
- 로컬 subject binding이 제거됩니다.
- Jungle LMS origin의 access·refresh cookie가 제거됩니다.
- Google origin의 SSO cookie는 남을 수 있습니다.
- 같은 사용자에 연결된 다른 PC와 모바일 session은 유지됩니다.

해제한 PC에서 다시 로그인하면 같은 LMS 계정은 기존 내부 사용자에
연결되어야 합니다.

## 결과 기록

다음은 자동 검증 결과로 간주하지 않고 수동 smoke 기록에 남깁니다.

| 항목 | 기록 |
| --- | --- |
| Google SSO·2단계 인증 완료 | 통과/실패와 실행 시각 |
| 첫 PC LMS 연결 | 통과/실패 |
| 재시작 뒤 session·subject 재검증 | 통과/실패 |
| 서버 LMS credential table 없음 | 통과/실패 |
| 추가 PC 동일 사용자 연결 | 수행/미수행 |
| 연동 해제와 재연결 | 통과/실패 |

## 실패 판독

| 현상 | 확인할 항목 |
| --- | --- |
| main 창이 빈 화면 | Vite 5173, `JB_APP_ORIGIN`, exact-origin navigation guard |
| 로그인 창이 열리지 않음 | `start_lms_login` capability와 Tauri log |
| Google 인증 직전 멈춤 | 허용된 Google HTTPS navigation과 WebView network |
| 인증 후 창이 닫히지 않음 | LMS `/api/v2/me` 상태와 agent callback generation |
| 창은 닫혔지만 main이 401 | access-only onboarding 응답과 app cookie 설치 |
| 재시작 뒤 계속 확인 중 | 현재 subject와 로컬 digest 불일치 또는 LMS session 만료 |
| 같은 계정이 사용자 둘로 분리됨 | 다른 LMS `id`, ID 앞뒤 공백·제어문자 등 입력 불일치 |

schema v5 이전 DB에 `subject_hmac` identity row가 있으면 현재 서버는
원본 LMS ID 없이 이를 SHA-256으로 변환하지 않고
`SQLITE_SCHEMA_RESET_REQUIRED`로 시작을 거부합니다. DB를 보존한 뒤 새
DB에서 실계정을 다시 검증하십시오. 기존 HMAC 값을 SHA-256 column으로
이름만 바꾸면 동일 사용자 판별이 깨지므로 허용하지 않습니다.
