# 플랫폼 상태 모델 레퍼런스

`frontend/src/platform/status-model.ts`는 Web, PWA, PC의 정적 capability와
인증, 푸시, 업데이트의 동적 상태 어휘를 정의하는 기준 계약이다.
현재 `PlatformAdapter`에 연결하는 작업은 후속 PR 범위다.

## 플랫폼 surface

| 값    | 판정 기준                                                            |
| ----- | -------------------------------------------------------------------- |
| `web` | 일반 브라우저 탭                                                     |
| `pwa` | `display-mode: standalone` 또는 iOS standalone으로 실행한 설치형 PWA |
| `pc`  | Tauri PC 앱                                                          |

PWA surface 판정은 UI 분기일 뿐 인증과 권한의 증명이 아니다.

## Capability matrix

아래 표의 키와 값은 `PLATFORM_CAPABILITY_MATRIX`와 동일하다.

| Surface | `publicFeatures` | `personalFeatures`        | `installation` | `authentication` | `notifications`    | `updates`         |
| ------- | ---------------- | ------------------------- | -------------- | ---------------- | ------------------ | ----------------- |
| `web`   | `available`      | `install-required`        | `pwa-install`  | `not-supported`  | `install-required` | `browser-managed` |
| `pwa`   | `available`      | `connection-required`     | `installed`    | `mobile-session` | `web-push`         | `service-worker`  |
| `pc`    | `available`      | `authentication-required` | `native-app`   | `lms-and-server` | `os-notification`  | `native-updater`  |

| Capability         | 값                        | 정의                                                          |
| ------------------ | ------------------------- | ------------------------------------------------------------- |
| `publicFeatures`   | `available`               | 홈, 세탁실, 식단, 앱 안내는 부가 상태와 무관하게 제공한다.    |
| `personalFeatures` | `install-required`        | Web에서는 설치 및 연결 동선만 제공한다.                       |
| `personalFeatures` | `connection-required`     | PWA는 PC와 연결한 뒤 개인 기능을 제공한다.                    |
| `personalFeatures` | `authentication-required` | PC는 LMS와 서버 인증을 완료한 뒤 개인 기능을 제공한다.        |
| `installation`     | `pwa-install`             | PWA 설치 안내와 지원되는 설치 prompt를 사용한다.              |
| `installation`     | `installed`               | 이미 설치된 standalone PWA다.                                 |
| `installation`     | `native-app`              | native installer로 설치한 Tauri 앱이다.                       |
| `authentication`   | `not-supported`           | Web은 개인 session을 받지 않는다.                             |
| `authentication`   | `mobile-session`          | PWA는 Strict HttpOnly mobile session을 사용한다.              |
| `authentication`   | `lms-and-server`          | PC는 LMS 로컬 상태와 서버 credential/session을 각각 확인한다. |
| `notifications`    | `install-required`        | Web은 알림 대신 PWA/PC 설치 동선을 제공한다.                  |
| `notifications`    | `web-push`                | PWA는 service worker와 Web Push를 사용한다.                   |
| `notifications`    | `os-notification`         | PC는 운영체제 알림을 사용한다.                                |
| `updates`          | `browser-managed`         | Web 자산 교체는 브라우저 새로고침으로 반영한다.               |
| `updates`          | `service-worker`          | PWA는 service worker 대기 및 교체 상태를 사용한다.            |
| `updates`          | `native-updater`          | PC는 Tauri native updater를 사용한다.                         |

## 인증 상태

`AuthenticationState`의 판별자는 `status`다.

| `status`        | 정의                                                 |
| --------------- | ---------------------------------------------------- |
| `checking`      | 현재 인증과 session을 확인 중이다.                   |
| `first-connect` | 이전 연결이 없어 첫 인증 또는 PC 연결이 필요하다.    |
| `authenticated` | 해당 surface의 인증 선행 조건을 모두 확인했다.       |
| `expired`       | 이전에 있던 credential 또는 session이 만료됐다.      |
| `offline`       | 네트워크 단절로 인증을 확인할 수 없다.               |
| `server-error`  | 서버 오류로 인증을 확인할 수 없다.                   |
| `recovering`    | 만료, offline 또는 서버 오류에서 복구를 시도 중이다. |

## 푸시 상태

`PushState`의 판별자는 `status`다.

| `status`             | 정의                                                    |
| -------------------- | ------------------------------------------------------- |
| `unsupported`        | 현재 surface 또는 런타임이 Push를 제공하지 않는다.      |
| `permission-default` | 알림 권한을 아직 요청하지 않았다.                       |
| `denied`             | 사용자 또는 운영체제가 알림 권한을 거부했다.            |
| `subscribed-local`   | 로컬 Push 구독은 있지만 서버 등록은 확인되지 않았다.    |
| `registered-server`  | 로컬 구독을 현재 계정의 서버에 등록했다.                |
| `test-sending`       | 현재 기기로 테스트 알림을 발송 중이다.                  |
| `arrived`            | 사용자가 테스트 알림의 실제 도착을 확인했다.            |
| `not-arrived`        | 사용자가 테스트 알림이 도착하지 않았음을 확인했다.      |
| `error`              | 권한 이후의 준비, 구독, 등록 또는 발송 단계가 실패했다. |

## 업데이트 상태

`UpdateState`의 판별자는 `status`다.

| `status`           | 정의                                          |
| ------------------ | --------------------------------------------- |
| `checking`         | 새 버전을 확인 중이다.                        |
| `latest`           | 현재 버전이 최신이다.                         |
| `optional`         | 나중에 적용할 수 있는 업데이트가 있다.        |
| `mandatory`        | 정상 사용 전에 적용해야 하는 업데이트가 있다. |
| `downloading`      | 업데이트를 다운로드 중이다.                   |
| `verifying`        | 다운로드한 업데이트를 검증 중이다.            |
| `installing`       | 검증한 업데이트를 설치 중이다.                |
| `restart-required` | 설치를 완료하려면 재시작해야 한다.            |
| `failed`           | 확인, 다운로드, 검증 또는 설치가 실패했다.    |

## 계약 불변조건

- Capability는 현재 준비 상태가 아닌 surface의 정적 지원 방식이다.
- 인증, 푸시, 업데이트는 `status`를 판별자로 가진 객체 union이다.
- Capability 셀과 동적 상태는 `boolean` 또는 `null`로 대체하지 않는다.
- `first-connect`와 `expired`, `offline`과 `server-error`, `subscribed-local`과
  `registered-server`, `arrived`와 `not-arrived`, `optional`과 `mandatory`를 합치지 않는다.
- 상태를 추가하거나 이름을 바꿀 때는 타입, 런타임 guard, 계약 테스트,
  이 문서를 함께 변경한다.

## 후속 PR wiring 규칙

| 경계              | 규칙                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface 판정      | Desktop build는 `pc`, browser에서 standalone 판정이 `true`이면 `pwa`, 나머지는 `web`으로 한 번만 정규화한다. URL 경로나 user agent를 권한 판정에 사용하지 않는다.   |
| 공개 기능         | 인증, 푸시, 업데이트 상태로 홈, 세탁실, 식단, 앱 안내 라우트를 차단하지 않는다.                                                                                     |
| 인증 producer     | 쿠키 유무, HTTP 응답, 네트워크 오류, LMS 상태를 producer 경계에서 `AuthenticationState`로 변환한다. 쿠키 없음만으로 `first-connect`와 `expired`를 선택하지 않는다.  |
| 푸시 producer     | 권한 → 로컬 구독 → 서버 등록 → 테스트 발송 → 실제 도착 확인 순서로 상태를 발행한다. API 성공이나 0개 대상을 `arrived`로 처리하지 않는다.                            |
| 업데이트 producer | 이전 `mandatory`를 저장한 뒤 새 확인이 실패해도 차단 상태를 보존한다. 다운로드, 검증, 설치, 재시작을 각각 발행한다.                                                 |
| 외부 응답         | 기존 `boolean` 또는 `null`은 producer 경계에서 명시적 우선순위로 새 상태에 매핑한다. 소비자에 원시값을 전파하지 않는다.                                             |
| 소비자            | `status`를 exhaustive switch로 처리하고 기본 분기로 알 수 없는 상태를 숨기지 않는다. 차단 UI는 현재 상태, 필요한 이유, 다음 행동, 복구 또는 나가기 경로를 표시한다. |

우선 wiring 대상은 `frontend/src/platform/contracts.ts`,
`frontend/src/app/dashboard-account-state.ts`,
`frontend/src/features/notifications/notification-delivery-setup.tsx`,
`frontend/src/app/desktop-update-gate.tsx`다.
