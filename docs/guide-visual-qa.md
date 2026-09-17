# 환경별 Visual QA

> 문서 유형: 방법 안내(how-to guide)

이 문서는 공통 절차와 프로젝트의 검증 범위를 설명합니다. 설치 경로·기기·포트·도구 활성
상태는 [로컬 QA 환경](reference-local-qa-environment.md)에서 관리합니다. 수행 결과는 대화로
전달하고, 필요한 상세 보고서·스크린샷은 저장소 밖 임시 경로에 둡니다.

QA 에이전트가 요청과 변경 내용을 바탕으로 확인할 동작을 선택합니다. 현재 화면·DOM·접근성
정보를 관찰하고, WebDriver·adb·브라우저 도구로 조작한 뒤 결과를 다시 확인합니다.
고정 스크립트의 종료 코드만으로 화면 QA가 끝났다고 판단하지 않습니다.

## 범위 선택과 릴리스 사본

일반 작업은 실행·화면 진입·대표 동작의 최소 스모크와 변경 범위만 확인합니다. 연결된 API나
플랫폼 동작이 함께 바뀌면 그 경로를 포함합니다. 문서만 바뀐 작업에 앱 QA를 추가하지 않습니다.

매 릴리스 공개 전에는 [전체 기능 QA 템플릿](template-release-qa.md)을 복사해 적용 가능한 모든
기능을 확인합니다. 기능별 기대 결과는 템플릿에, 조작 방법은 이 안내에 둡니다. 저장소 루트에서:

```bash
qa_release_dir=$(mktemp -d "${TMPDIR:-/tmp}/jungle-bell-release-qa.XXXXXX")
cp docs/template-release-qa.md "$qa_release_dir/release-qa.md"
```

사본에 후보 버전·SHA·대상 환경을 채우고 결과를 기록합니다. 공통 로직은 같은 SHA의 기존
테스트·CI 결과를 재사용할 수 있습니다. 시간·날짜·중복·재시도 조건을 확인하려고 실제로 오래
기다릴 필요는 없습니다. 화면 조작·설치·OS 알림의 통과는 실제 관찰을 근거로 남깁니다.
개발 빌드·fixture·시뮬레이터로 확인한 범위와 실제 릴리스 설치본의 결과를 구분합니다.

릴리스에서는 플랫폼별 적용 범위를 정하고, 기능별 결과와 미확인 환경을 빠짐없이 기록합니다.
해당 환경·릴리스에 적용되지 않는 항목은 `N/A`, 계정·기기·도구가 없어 실행하지 못한 항목은 `BLOCKED`로 남깁니다.
일반 작업은 선택한 항목만 기록하면 됩니다. 실패를 수정했다면 영향 항목만 다시 확인합니다.

## 계정이 필요한 경우

계정 사용, LMS 로그인·MFA, 기기 연결·해제, 세션 만료 재현이나 identity 초기화가 필요하면
QA 담당자는 메인 에이전트에 항목 ID·필요한 계정/기기·변경할 상태를 전달합니다. 메인이
사용자에게 QA 계정 준비나 직접 로그인, 변경 허용 범위를 요청합니다. 비밀번호·인증 코드·
쿠키·토큰을 문서나 메시지에 붙여 넣도록 요청하지 않습니다.

사용자가 이미 허용한 계정과 범위는 재사용합니다. 준비가 필요한 항목은 `BLOCKED`로 두고
공개 기능 등 독립적인 QA를 진행합니다. 해제·초기화·OS 설정 변경은 허용된 QA 프로필에서
수행하고, 종료 시 복구하거나 폐기할 범위도 메인을 통해 확인합니다.

## 실행 환경 선택

기본은 **사용자 PC의 커서와 포커스를 점유하지 않는 조작·캡처**입니다. 에이전트는 기기나
WebView에서 받은 화면을 보고 다음 동작을 결정합니다. 이를 위해 고정 테스트 스크립트로
바꿀 필요는 없습니다. 여기서 백그라운드는 호스트 화면을 점유하지 않는다는 뜻이며,
테스트 대상 앱 자체를 백그라운드로 보내는 수명주기 검증과는 다릅니다.

| 환경 | 커서를 점유하지 않는 경로 | 한계 |
| --- | --- | --- |
| Android | `-no-window` + `adb input`·UIAutomator·`screencap` | 앱은 가상 기기 안에서 실행·표시되며 PC의 마우스는 사용하지 않음 |
| iOS | Simulator.app을 열지 않고 `simctl boot/openurl/io screenshot` | 탭·스와이프·입력은 별도 XCUITest/WebDriverAgent 연결이 필요 |
| Tauri | `JUNGLE_BELL_WINDOW_FOCUS=false` + WebDriver의 요소 조작·WebView screenshot | 숨긴 창·최소화한 창은 복원하지 않으며 해당 상태의 렌더링은 별도 확인 필요 |
| 웹 | Playwright headless Chromium의 locator 조작·탭 캡처 | 실제 OS 대화상자는 별도 범위 |

캡처 파일은 이미지 도구로 읽고 Preview·Simulator 등을 매번 전경으로 열지 않습니다.
사용자 데스크톱의 트레이·OS 대화상자·실제 포커스 전환을 확인해야 하면 메인에게 해당 범위를
알리고 사용자와 전경 작업 시간을 맞춥니다. 도구가 안 된다는 이유로 임의로 마우스 조작에
전환하지 않습니다.

확인할 동작에 맞는 환경만 선택합니다. 화면을 좁힌 브라우저를 실제 모바일이나 설치형 PWA의
검증 결과로 취급하지 않습니다. [Chrome Device Mode의 한계](https://developer.chrome.com/docs/devtools/device-mode#limitations)도 참고합니다.

| 확인 대상 | 사용할 환경 |
| --- | --- |
| 공통 화면·반응형 배치·웹 탐색 | Playwright headless Chromium |
| Android 브라우저·터치·키보드·설치 흐름 | Android 에뮬레이터 또는 기기 |
| iOS Safari·안전 영역·키보드·홈 화면 실행 | iOS 시뮬레이터 또는 기기 |
| Tauri 앱 내부 화면·탐색·Rust IPC 연동 | 실제 앱의 내장 WebDriver |
| Tauri OS 포커스 | 실제 앱과 OS 활성 앱·창 관측기 |
| Tauri 창 조작·트레이·OS 대화상자 | 실제 데스크톱 앱과 네이티브 Computer Use 또는 수동 조작 |
| 설치·Service Worker·오프라인·Web Push | 승인된 HTTPS 테스트 환경의 설치형 PWA |

사용자의 기존 로그인·쿠키·앱 데이터와 실행 중인 기기는 유지합니다. 필요하면 별도 QA
프로필·기기·계정을 준비합니다. 대상 동작을 실제로 수행하고 결과를 설명하는 화면만 캡처합니다.

## 브라우저에서 화면 확인

웹 QA에는 [Playwright Chromium 안내](guide-playwright-qa.md)를 사용합니다. 에이전트가 지속
세션에서 현재 화면을 관찰하고 개별 동작을 선택합니다. 실제 Chromium 실행·페이지 캡처를
확인하며 고정 E2E 스크립트나 브라우저 창을 띄우는 작업을 필수로 두지 않습니다.

[개발 도구](../CONTRIBUTING.md)를 준비하고 빈 개발 서버 포트를 `qa_web_port`로 지정합니다.
`frontend/`에서 실행합니다.

```bash
mise exec -- npm run dev:web -- --host 127.0.0.1 --port "$qa_web_port" --strictPort
```

브라우저에서 `http://127.0.0.1:<qa_web_port>`를 열고 필요한 크기로 조정합니다. 주요 동작을 직접
실행하면서 잘림·스크롤·포커스·로딩·오류 표시를 확인하고, 결과를 보여주는 상태를 캡처합니다.
자동화 도구를 사용할 때는 현재 제공되는 Browser/Computer Use API 문서를 따릅니다.

별도 브라우저 도구를 쓰는 경우 제공 API와 실제 엔진을 확인하고 대상 탭을 선택합니다.
조작 뒤 새 접근성 트리·DOM·스크린샷으로 결과를 확인합니다. 가로 잘림처럼 수치로 확인 가능한
문제는 DOM의 `clientWidth`, `scrollWidth`, `scrollLeft`도 기록합니다.
이 프로젝트의 예시는 세탁실 표 내부 가로 스크롤, 알림 패널 닫기와 포커스 복귀,
설치 안내 탭·이미지 확대입니다. 변경과 관련된 동작만 선택합니다.

기본 `/api` 프록시는 `https://jungle-bell.sijun-yang.com`을 사용합니다. 테스트 서버로
바꾸려면 시작 명령에 `JUNGLE_BELL_DEV_API_ORIGIN`을 지정합니다. dev 모드에서는
Service Worker와 자동 UI 열림 통계가 비활성화됩니다. 실제 데이터와 fixture를 구분해 기록합니다.

급식 검증에는 이미지 URL의 origin도 화면이 기대하는 origin과 일치하는 API 응답을 사용합니다.
재사용할 환경 제약만 환경 참조에 반영하며, 검증을 위해 origin 검사를 완화하지 않습니다.

설치형 PWA는 production 빌드와 API 경로가 준비된 승인된 HTTPS 테스트 origin에서 확인합니다.
`build:web`와 `preview:web`만으로 API 연결까지 구성됐다고 가정하지 않습니다. 현재 API 프록시는
개발 서버 설정에 있습니다. 홈 화면에 설치한 뒤 아이콘으로 다시 열어 standalone 실행을 확인합니다.
iOS Web Push는 홈 화면 웹 앱에서 사용자 조작으로 권한을 요청하는 흐름을 확인합니다.
실제 알림 수신을 시험하지 않았다면 성공으로 표시하지 않습니다. [WebKit 안내](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## iOS 시뮬레이터

Xcode와 대상 iOS runtime을 설치한 환경에서 사용합니다. Xcode의 Developer 디렉터리를
`qa_developer_dir`, 저장소 밖 새 임시 캡처 디렉터리를 `qa_artifacts`로 지정합니다.
`DEVELOPER_DIR`은 명령별로 적용하며 전역 `xcode-select` 설정은 변경하지 않습니다.

```bash
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl list
```

목록에서 사용 가능한 Device Type ID와 Runtime ID를 골라 `qa_device_type`, `qa_runtime`에
넣습니다. 다음은 임시 기기 생성·실행 예시이며, 명령 나열 자체가 검증 결과는 아닙니다.

```bash
qa_simulator_id=$(DEVELOPER_DIR="$qa_developer_dir" xcrun simctl create "Jungle Bell QA" "$qa_device_type" "$qa_runtime")
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl boot "$qa_simulator_id"
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl bootstatus "$qa_simulator_id" -b
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl openurl "$qa_simulator_id" "http://127.0.0.1:$qa_web_port"
```

기본 경로는 Simulator.app을 열지 않고 아래 `io screenshot`으로 Safari 화면을 관찰합니다.
`simctl`은 부팅·URL 열기·캡처를 제공하지만 일반적인 탭·스와이프·타이핑 도구는 아닙니다.
커서를 점유하지 않는 임의 조작에는 Appium XCUITest/WebDriverAgent 같은 기기 내부 드라이버가
필요합니다. 연결된 드라이버가 없으면 조작 범위를 미실행으로 남깁니다. 단순 URL 열기와 캡처를
터치·설치 검증으로 확대하지 않습니다. [Apple의 simctl 안내](https://developer.apple.com/videos/play/wwdc2019/418/)

Appium의 `appium:isHeadless=true`는 **실행 중인 Simulator UI들을 종료할 수 있으므로**
사용자가 Simulator를 사용하는 호스트에서 무조건 적용하지 않습니다. 전용 QA 기기·환경을
사용하고 실제 driver 연결 여부는 환경 참조에 기록합니다.
[Appium Simulator 옵션](https://appium.github.io/appium-xcuitest-driver/latest/reference/capabilities/#simulator)

```bash
mkdir -p "$qa_artifacts"
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl io "$qa_simulator_id" screenshot "$qa_artifacts/ios.png"
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl shutdown "$qa_simulator_id"
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl delete "$qa_simulator_id"
```

삭제는 이번 작업에서 생성한 기기에만 적용합니다. Push·백그라운드 복귀는 해당 기기에서
직접 시험한 범위를 기록하고, 실제 기기에서 확인할 부분을 구분합니다.

## Android 에뮬레이터

먼저 `ANDROID_HOME`·`ANDROID_USER_HOME`·`ANDROID_AVD_HOME`, PATH, 이전 QA 기록에서
실제 SDK·AVD 위치를 확인합니다. 기본 경로에 없다는 이유만으로 미설치로 판단하지 않습니다.
SDK의 `emulator`와 `adb`만으로 부팅·탭·스와이프·뒤로 가기·캡처를 수행할 수 있습니다.
네이티브 Computer Use 플러그인은 필요하지 않습니다. 실행 환경·기존 AVD를 보존하는 부팅 옵션·
조작과 종료 명령은 [Android QA](guide-android-qa.md)를 따릅니다.

## Tauri WebDriver

앱 내부 화면은 [Tauri WebDriver QA](guide-tauri-webdriver-qa.md)를 사용합니다.
macOS에서는 QA 앱에 내장 WebDriver 플러그인을 연결하고 실제 WKWebView를 조작합니다.
브라우저용 Tauri mock 없이 화면과 Rust IPC를 확인할 수 있으며 네이티브 Computer Use와 별개입니다.
트레이·OS 대화상자·다른 앱은 이 드라이버의 검증 범위가 아닙니다.

## 네이티브 데스크톱

OS 포커스는 [Tauri QA의 관측 절차](guide-tauri-webdriver-qa.md#os-포커스-측정macos)로 확인할 수 있습니다.
이 읽기 전용 관측은 네이티브 Computer Use 제공 여부와 별개입니다.

앱 목록이 없으면 메인에서도 같은지 확인하고 Computer Use 플러그인의 활성 상태를 점검합니다.
브라우저 도구 제공과 네이티브 제공은 별개입니다. [공식 설정 안내](https://learn.chatgpt.com/docs/computer-use#set-up-computer-use)에 따라
플러그인·서버·스킬을 켜고, macOS 화면 기록·손쉬운 사용 권한과 앱별 허용을 따로 확인합니다.

[PC 앱 실행 안내](../CONTRIBUTING.md)를 사용합니다. 앱 시작만으로 PC 설치 등록·heartbeat 등
서버 쓰기가 발생할 수 있으므로 정적 캡처로 취급하지 않습니다. 필요하면 격리된 QA 계정·서버를 사용합니다.
Computer Use의 현재 API로 실제 앱을 선택하고 창·트레이·OS 대화상자를 조작하며 관찰·캡처합니다.
네이티브 조작 도구가 없으면 그 범위는 미실행으로 남기고 브라우저 결과로 대체하지 않습니다.
큰 기능 완료나 최종 릴리스의 전체 Tauri 화면 확인에는 기존
[capture-jungle-bell-ui](../.agents/skills/capture-jungle-bell-ui/SKILL.md) 절차를 사용합니다.

## 기록과 정리

결과는 수행 환경·관찰 내용·미실행 항목을 대화로 요약합니다. 자세한 근거가 필요하면
보고서·스크린샷·로그·결과 JSON을 저장소 밖 임시 경로에 두고 링크로 전달합니다.
실행 기록과 결과물은 코드베이스에 보관하거나 커밋하지 않습니다. 저장소에는 재사용할 절차·
도구·환경 정보만 유지합니다. 로그·이미지에 인증 정보나 세션 원문을 포함하지 않습니다.
이번 작업이 시작한 서버·임시 기기·캡처용 변경만 정리하고 사용자 세션과 결과 이미지는 보존합니다.
