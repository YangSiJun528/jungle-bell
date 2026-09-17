# Android Chrome에서 UI 확인하기

> 문서 유형: 방법 안내(how-to guide)

Android 에뮬레이터의 Chrome에서 공통 React 화면을 열고 `adb`로 탭·스크롤·뒤로 가기를
수행하는 절차입니다. 실제 Android OS와 브라우저를 사용하며, Tauri PC 앱의 네이티브 연동은
검증하지 않습니다. 환경 선택과 PWA 검증 범위는 [환경별 Visual QA](guide-visual-qa.md)를 참고합니다.

## SDK와 QA 기기 찾기

먼저 `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, `ANDROID_AVD_HOME`과
실제 설치 위치를 확인합니다. PATH나 기본 설치 경로에 없다는 이유만으로 미설치로 판단하지
않습니다. 이 컴퓨터의 경로·기기·포트 선택값은 [로컬 QA 환경](reference-local-qa-environment.md)에 있습니다.
명령을 실행하는 각 터미널에서 환경 변수를 설정하고, QA AVD 이름을 `qa_avd`, 빈 emulator
console 포트를 `qa_emulator_port`, 빈 웹 포트를 `qa_web_port`, 저장소 밖 새 임시 캡처
디렉터리를 `qa_artifacts`로 지정합니다.

```bash
qa_adb="$ANDROID_HOME/platform-tools/adb"

"$qa_adb" version
"$qa_adb" devices -l
"$ANDROID_HOME/emulator/emulator" -list-avds
```

`ANDROID_AVD_HOME`은 AVD 등록 `.ini`가 있는 디렉터리입니다. 실제 디스크 디렉터리는 그
`.ini`의 `path`를 따릅니다.
이미 실행 중인 기기는 그대로 두고, 조작·종료할 QA 기기의 serial을 구분합니다.

## 기존 데이터를 보존하며 실행하기

emulator console에는 허용 범위의 짝수 포트를 선택합니다. 그 다음 포트는 adb 연결에 쓰므로
둘 다 비어 있어야 합니다. macOS에서는 다음 명령으로 포트 충돌을 확인할 수 있습니다.

```bash
qa_emulator_adb_port=$((qa_emulator_port + 1))
lsof -nP -iTCP:"$qa_web_port" -iTCP:"$qa_emulator_port" -iTCP:"$qa_emulator_adb_port" -sTCP:LISTEN
"$ANDROID_HOME/emulator/emulator" -help-read-only
"$ANDROID_HOME/emulator/emulator" -help-no-snapshot-save
```

사용 중이면 다른 빈 포트를 고르고 아래 포트·serial·URL을 함께 바꿉니다. 기존 QA AVD는
`-read-only`로 실행하고, 스냅샷을 읽거나 저장하지 않는 cold boot를 사용합니다.
AVD 삭제나 `-wipe-data`는 사용하지 않습니다. `-no-window`는 호스트의 에뮬레이터 창만
숨기며, 기기 화면은 `adb screencap`으로 관찰할 수 있습니다.
[Emulator 실행 옵션](https://developer.android.com/studio/run/emulator-commandline)

이 방식을 기본으로 사용합니다. `adb input`은 Android 내부에 입력을 보내므로 호스트의
커서·키보드 포커스를 가져오지 않습니다. 캡처도 호스트 바탕화면이 아닌 기기 화면을 읽습니다.
PNG는 에이전트의 이미지 도구로 확인하며 에뮬레이터 창이나 이미지 뷰어를 띄울 필요가 없습니다.
[adb 화면 캡처](https://developer.android.com/tools/adb#screencap)

```bash
"$ANDROID_HOME/emulator/emulator" -avd "$qa_avd" \
  -port "$qa_emulator_port" -read-only -no-snapshot-save -no-snapshot-load -no-window -no-audio
```

다른 터미널의 `frontend/`에서 개발 서버를 시작합니다.

```bash
mise exec -- npm run dev:web -- --host 127.0.0.1 --port "$qa_web_port" --strictPort
```

부팅을 확인한 뒤 Chrome을 엽니다. `sys.boot_completed`가 `1`이 될 때까지 기다립니다.
`10.0.2.2`는 Android 에뮬레이터에서 호스트의 loopback에 접근하는 주소입니다.
[네트워크 주소 안내](https://developer.android.com/studio/run/emulator-networking-address)

```bash
qa_serial="emulator-$qa_emulator_port"
"$qa_adb" -s "$qa_serial" shell getprop sys.boot_completed
"$qa_adb" -s "$qa_serial" shell am start \
  -a android.intent.action.VIEW -d "http://10.0.2.2:$qa_web_port/#/laundry" com.android.chrome
```

`adb`의 `Operation not permitted`나 로컬 listener 생성 실패는 SDK 미설치와 구분합니다.
Codex sandbox에서 이런 오류가 나면 승인된 QA 범위에서 해당 명령의 권한을 요청해 재시도합니다.

## 화면을 관찰하고 조작하기

조작 전후에 PNG와 UIAutomator XML을 저장합니다. 웹 내용이 아직 XML에 없다면 화면이
로드된 뒤 다시 관찰합니다. XML의 `bounds`와 현재 스크린샷을 근거로 좌표를 정하고,
이전 실행의 좌표를 다른 해상도에 그대로 적용하지 않습니다.

```bash
mkdir -p "$qa_artifacts"
"$qa_adb" -s "$qa_serial" shell uiautomator dump /sdcard/jungle-bell-qa.xml
"$qa_adb" -s "$qa_serial" exec-out cat /sdcard/jungle-bell-qa.xml > "$qa_artifacts/before.xml"
"$qa_adb" -s "$qa_serial" exec-out screencap -p > "$qa_artifacts/before.png"
```

현재 화면에서 정한 `qa_x`, `qa_y`, `qa_from_x`, `qa_from_y`, `qa_to_x`, `qa_to_y`를 넣어
조작합니다. 캡처는 상태마다 다른 파일명으로 저장합니다.

```bash
"$qa_adb" -s "$qa_serial" shell input tap "$qa_x" "$qa_y"
"$qa_adb" -s "$qa_serial" shell input swipe "$qa_from_x" "$qa_from_y" "$qa_to_x" "$qa_to_y" 600
"$qa_adb" -s "$qa_serial" shell input keyevent KEYCODE_BACK
```

변경과 관련된 흐름만 골라 수행합니다.

| 흐름 | 조작과 확인 |
| --- | --- |
| 세탁실 표 | 세로 스크롤로 워시타워 표를 찾고 표 안에서 가로 swipe. 오른쪽 열이 보이는지, 표 밖 메뉴·카드가 함께 옆으로 밀리지 않는지 확인합니다. |
| 알림 패널 | 상단 알림 버튼 → 설치 필요 안내 → 닫기. 원래 화면으로 돌아오는지와 알림 버튼의 포커스 복귀를 확인합니다. |
| 설치 안내 | 알림 패널의 앱 설치 안내 → Android·iOS 안내 탭 전환 → 이미지 확대·닫기. 실제 Chrome 메뉴도 열고 시스템 뒤로 가기로 닫습니다. |

이 흐름은 공개 데이터와 안내 화면만 사용합니다. 운영 데이터 지연·오류는 별도로 기록합니다.
dev 모드는 Service Worker와 자동 UI 열림 통계가 비활성화되며, 이 HTTP 실행을 설치형 PWA·
오프라인·Push 성공으로 기록하지 않습니다. 로그인, PC 연결, 최종 설치, 알림 권한·수신은
별도 테스트 범위와 환경을 정한 뒤 수행합니다.

## 종료하고 결과 남기기

이번 작업에서 시작한 기기만 종료하고, 개발 서버를 실행한 터미널에서 `Ctrl-C`로 종료합니다.
기존 AVD 디스크와 스냅샷은 남겨 둡니다.

```bash
"$qa_adb" -s "$qa_serial" emu kill
"$qa_adb" devices -l
lsof -nP -iTCP:"$qa_web_port" -iTCP:"$qa_emulator_port" -iTCP:"$qa_emulator_adb_port" -sTCP:LISTEN
```

`adb` 서버도 이번에 시작했고 다른 기기가 사용하지 않을 때만 `adb kill-server`로 종료합니다.
Android·Chrome 버전, 실제 조작·결과·미실행과 정리 상태를 대화로 요약합니다.
필요한 PNG·XML·상세 보고서는 저장소 밖 임시 경로에서 전달하며 커밋하지 않습니다.
SDK·AVD 경로 등 재사용할 환경 정보가 바뀌었다면
[로컬 QA 환경](reference-local-qa-environment.md)을 갱신합니다.
