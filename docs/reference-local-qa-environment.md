# 로컬 QA 환경

> 문서 유형: 참조(reference)

이 컴퓨터에서 **2026-09-17에 확인한 환경**입니다. 설치 위치·버전·도구 제공 상태가 바뀌면
이 문서를 갱신합니다. 공통 절차는 [환경별 Visual QA](guide-visual-qa.md)를 참고합니다.
이 문서에는 재사용할 환경 정보만 유지하며 실행 결과·보고서는 포함하지 않습니다.

아래 포트는 로컬 실행 설정 예시이며 현재 비어 있다는 보장은 없습니다.
임시 경로의 파일도 실행 전에 존재 여부를 확인합니다.

## 호스트와 도구

| 항목 | 마지막 확인 상태 |
| --- | --- |
| OS | macOS 26.5.2, build 25F84 |
| 프로젝트 실행 도구 | `mise exec`, Node 24.21.0, Cargo 1.98.1 |
| 브라우저 조작 | Codex In-app Browser 사용 가능 |
| 네이티브 Computer Use | 메인·하위 에이전트 모두 네이티브 API 미제공 |
| 플러그인 구성 | `computer-use@openai-bundled` 비활성, `unified-computer-use`는 `browser` 표면만 제공 |
| macOS 화면 기록·손쉬운 사용 권한 | 미확인 |

이 도구 상태는 Codex나 운영체제의 영구 제약이 아닙니다. 다음 실행에서는 제공 도구와
플러그인 설정을 다시 확인합니다. 이 환경에서는 시뮬레이터·서버 bind에 sandbox 밖 실행이
필요할 수 있습니다. Android Emulator의 Qt `requires neon` 오류도 sandbox 제한과 구분해 확인합니다.

## Android

| 항목 | 값 |
| --- | --- |
| SDK | `/private/tmp/jungle-bell-pwa-install-guide-20260916/android/sdk` |
| Android 사용자 디렉터리 | `/private/tmp/jungle-bell-pwa-install-guide-20260916/android/user` |
| AVD 등록 디렉터리 | 위 사용자 디렉터리의 `avd/` |
| AVD 실제 데이터 | `/private/tmp/jungle-bell-pwa-install-guide-20260916/android/avd/JungleBell_PWA_Guide.avd` |
| AVD 이름 | `JungleBell_PWA_Guide` |
| 런타임·화면 | Android 16/API 36 arm64, 1080×2400 |
| 도구·브라우저 | adb 37.0.1, Emulator 37.1.11.0, Chrome 133.0.6943.137 |
| 포트·serial 예시 | 웹 5174, emulator 5560·5561, serial `emulator-5560` |

[Android 가이드](guide-android-qa.md)에 사용할 이 컴퓨터의 설정값입니다.
포트 충돌을 확인하고 캡처 경로는 실행마다 새로 지정합니다.

```bash
qa_android_base=/private/tmp/jungle-bell-pwa-install-guide-20260916/android
export ANDROID_HOME="$qa_android_base/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$qa_android_base/user"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
qa_avd=JungleBell_PWA_Guide
qa_emulator_port=5560
qa_web_port=5174
qa_artifacts="/private/tmp/jungle-bell/android-qa-$(date +%Y%m%d-%H%M%S)"
```

## iOS와 일반 브라우저

| 항목 | 값 |
| --- | --- |
| Xcode | 26.6, `/Applications/Xcode.app/Contents/Developer` |
| 시뮬레이터 구성 | iPhone 17 Pro, iOS 26.5 |
| 웹 포트 예시 | 5173 |

[공통 가이드](guide-visual-qa.md)의 명령에 넣을 값입니다. Device Type ID와 Runtime ID는
`simctl list`에서 다시 선택합니다.

```bash
qa_developer_dir=/Applications/Xcode.app/Contents/Developer
qa_web_port=5173
qa_artifacts="/private/tmp/jungle-bell/ios-qa-$(date +%Y%m%d-%H%M%S)"
```

## Tauri

도구 조합은 Tauri 2.11.5와 내장 WebDriver 1.4.0이며 드라이버 포트 예시는 4445입니다.
[Tauri 가이드](guide-tauri-webdriver-qa.md)에 사용할 새 경로와 API·포트 예시입니다.

```bash
qa_root="/private/tmp/jungle-bell/tauri-qa-$(date +%Y%m%d-%H%M%S)"
qa_api_origin=https://jungle-bell.sijun-yang.com
qa_webdriver_port=4445
```

## 확인된 환경 조합의 제약

로컬 `dev:web`과 운영 API 프록시 조합에서는 급식 이미지 origin이 로컬 화면 origin과 달라
`API_RESPONSE_INVALID`가 발생할 수 있습니다. 정상 급식 QA에는 origin이 맞는 API 응답이 필요합니다.
