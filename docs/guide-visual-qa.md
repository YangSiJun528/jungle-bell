# 환경별 Visual QA

> 문서 유형: 방법 안내(how-to guide)

이 문서는 공통 절차와 프로젝트의 검증 범위를 설명합니다. 설치 경로·기기·포트·도구 활성
상태는 [로컬 QA 환경](reference-local-qa-environment.md)에서 관리합니다. 수행 결과는 대화로
전달하고, 필요한 상세 보고서·스크린샷은 저장소 밖 임시 경로에 둡니다.

QA 에이전트가 요청과 변경 내용을 바탕으로 확인할 동작을 선택합니다. 현재 화면·DOM·접근성
정보를 관찰하고, WebDriver·adb·브라우저 도구로 조작한 뒤 결과를 다시 확인합니다.
고정 스크립트의 종료 코드만으로 화면 QA가 끝났다고 판단하지 않습니다.

확인할 동작에 맞는 환경만 선택합니다. 화면을 좁힌 브라우저를 실제 모바일이나 설치형 PWA의
검증 결과로 취급하지 않습니다. [Chrome Device Mode의 한계](https://developer.chrome.com/docs/devtools/device-mode#limitations)도 참고합니다.

| 확인 대상 | 사용할 환경 |
| --- | --- |
| 공통 화면·반응형 배치·웹 탐색 | 데스크톱 브라우저 |
| Android 브라우저·터치·키보드·설치 흐름 | Android 에뮬레이터 또는 기기 |
| iOS Safari·안전 영역·키보드·홈 화면 실행 | iOS 시뮬레이터 또는 기기 |
| Tauri 앱 내부 화면·탐색·Rust IPC 연동 | 실제 앱의 내장 WebDriver |
| Tauri 창·트레이·OS 대화상자 | 실제 데스크톱 앱과 네이티브 Computer Use 또는 수동 조작 |
| 설치·Service Worker·오프라인·Web Push | 승인된 HTTPS 테스트 환경의 설치형 PWA |

사용자의 기존 로그인·쿠키·앱 데이터와 실행 중인 기기는 유지합니다. 필요하면 별도 QA
프로필·기기·계정을 준비합니다. 대상 동작을 실제로 수행하고 결과를 설명하는 화면만 캡처합니다.

## 브라우저에서 화면 확인

[개발 도구](../CONTRIBUTING.md)를 준비하고 빈 개발 서버 포트를 `qa_web_port`로 지정합니다.
`frontend/`에서 실행합니다.

```bash
mise exec -- npm run dev:web -- --host 127.0.0.1 --port "$qa_web_port" --strictPort
```

브라우저에서 `http://127.0.0.1:<qa_web_port>`를 열고 필요한 크기로 조정합니다. 주요 동작을 직접
실행하면서 잘림·스크롤·포커스·로딩·오류 표시를 확인하고, 결과를 보여주는 상태를 캡처합니다.
자동화 도구를 사용할 때는 현재 제공되는 Browser/Computer Use API 문서를 따릅니다.

Codex에서는 `cua.getState()`로 사용 가능한 표면을 확인한 뒤 브라우저 탭이나 앱을 선택합니다.
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
open -a "$qa_developer_dir/Applications/Simulator.app"
DEVELOPER_DIR="$qa_developer_dir" xcrun simctl openurl "$qa_simulator_id" "http://127.0.0.1:$qa_web_port"
```

Simulator에서 이 기기를 선택하고 Safari 화면을 관찰합니다. 설치·키보드 등 필요한 조작은
사용 가능한 Computer Use나 수동 조작으로 수행합니다. 단순 URL 열기와 캡처를 터치·설치 검증으로 확대하지 않습니다.

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
