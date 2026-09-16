# Tauri WebDriver QA

> 문서 유형: 방법 안내(how-to guide)

QA 에이전트가 WebDriver로 실제 Jungle Bell 앱을 조작하며 화면·탐색·Rust IPC를 확인합니다.
준비 스크립트는 macOS용 QA 앱에 드라이버를 연결하는 역할만 맡습니다.
[Tauri 공식 안내](https://v2.tauri.app/develop/tests/webdriver/)의 내장 WebDriver 방식이며,
`tauri-plugin-wdio-webdriver` 1.4.0을 QA 복사본에만 추가합니다. 이 버전은 Tauri 2.10 이상이 필요합니다.
배포 앱·트레이·OS 대화상자까지 검증하는 절차는 아닙니다.

## QA 앱 준비

[개발 환경](../CONTRIBUTING.md)의 Node·Rust·Xcode와 Python 3.9 이상이 필요합니다.
설치된 버전·로컬 경로·API·포트 선택값은 [로컬 QA 환경](reference-local-qa-environment.md)에 있습니다.
저장소 루트에서 `qa_root`에는 아직 없는 저장소 밖 경로, `qa_api_origin`에는 대상 API,
`qa_webdriver_port`에는 빈 드라이버 포트를 지정합니다. 스크립트의 기본 포트는 4445입니다.

```bash
qa_repo="$PWD"
JUNGLE_BELL_DATA_API_URL="$qa_api_origin" \
  mise exec -- npm --prefix frontend run build:desktop-ui
python3 scripts/qa/prepare-tauri-webdriver.py "$qa_root" --port "$qa_webdriver_port"
JUNGLE_BELL_DATA_API_URL="$qa_api_origin" \
  mise exec -- sh -c 'cd "$1/desktop" && exec "$2/frontend/node_modules/.bin/tauri" build --debug --bundles app --features qa-webdriver' sh "$qa_root" "$qa_repo"
```

[준비 스크립트](../scripts/qa/prepare-tauri-webdriver.py)는 현재 소스와 빌드한 UI를 복사합니다.
앱 이름·identifier·설정 경로를 분리하고 WebView를 비영구 모드로 엽니다. 자동 시작·사용량 수집을
끄고 updater endpoint를 비웁니다. 업데이트 확인은 QA feature에서 `latest`로 고정하여
차단 화면 없이 탐색하며 업데이트 다운로드·설치는 수행하지 않습니다. WebDriver는 명시적 feature와
debug 빌드에서만 등록됩니다. 원본 Cargo 의존성·앱 코드·사용자 설정은 수정하지 않습니다.

이 복사본은 **새 프로필의 화면·IPC QA용**입니다. 저장된 LMS 세션·자동 업데이트는 검증할 수 없습니다.
앱을 시작하면 새 PC 설치 등록·heartbeat 등 서버 쓰기는 발생할 수 있습니다.
별도 API를 사용한다면 현재 앱의 서버·CSP 설정에 맞는 테스트 환경을 준비합니다.

## 앱 실행

같은 터미널에서 QA `.app` 안의 실행 파일을 실행합니다. 기존 설치 앱을 열지 않습니다.

```bash
qa_app=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["productName"])' "$qa_root/qa-environment.json")
"$qa_root/desktop/target/debug/bundle/macos/$qa_app.app/Contents/MacOS/jungle-bell" \
  > "$qa_root/app.log" 2>&1 &
qa_app_pid=$!
```

드라이버는 지정한 포트의 `127.0.0.1`에 연결합니다. 이 서버를 외부에 노출하지 않습니다.
준비된 앱에 세션을 만들고 항상 `dashboard` 창을 명시합니다. 기본 창을 자동 선택하면
외부 LMS checker가 선택될 수 있습니다.

```bash
qa_driver_url="http://127.0.0.1:$qa_webdriver_port"
curl --fail --silent "$qa_driver_url/status"
qa_session_id=$(curl --fail --silent -H 'Content-Type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"browserName":"tauri","wdio:tauriServiceOptions":{"windowLabel":"dashboard"}}}}' \
  "$qa_driver_url/session" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"]["sessionId"])')
```

## 에이전트가 관찰하고 조작하기

에이전트가 현재 화면과 요소를 읽고 요청에 필요한 조작을 선택합니다. 조작 뒤 상태가 바뀌면
다시 관찰하여 다음 행동을 결정합니다. 특정 페이지 순서나 고정 시나리오는 요구하지 않습니다.
아래 요청은 각각 필요할 때 호출합니다. HTTP 성공은 명령 수행 결과이며 QA 판정은 에이전트가 합니다.

| 작업 | 세션 아래 API | 요청·응답 |
| --- | --- | --- |
| DOM 관찰 | `POST /execute/sync` | `{"script":"읽기 전용 관찰 코드","args":[]}` |
| 요소 찾기 | `POST /element` | `{"using":"css selector","value":"관찰한 요소의 선택자"}` → `value["element-6066-11e4-a52e-4f735466cecf"]` |
| 클릭 | `POST /element/{elementId}/click` | `{}` |
| 캡처 | `GET /screenshot` | `value`에 base64 PNG |

예를 들어 다음 요청으로 현재 URL과 화면 요소의 이름을 읽습니다. 입력값이나 세션 원문은 수집하지 않습니다.

```bash
curl --fail --silent -H 'Content-Type: application/json' \
  -d '{"script":"return {url:location.href,title:document.title,elements:[...document.querySelectorAll(\"button,a,[role=tab]\")].filter(e=>e.getClientRects().length&&!e.closest(\"[inert],[aria-hidden=true]\")).map(e=>({tag:e.tagName,text:e.innerText,label:e.getAttribute(\"aria-label\"),href:e.getAttribute(\"href\")}))}","args":[]}' \
  "$qa_driver_url/session/$qa_session_id/execute/sync"
```

선택자는 현재 관찰한 요소에서 정합니다. 알림 버튼 이름은 읽지 않은 개수에 따라 달라집니다.
차단막에 가려지거나 `inert`인 요소를 우회해서 클릭하지 않습니다. 전환 중인 화면은 기다렸다가
다시 관찰합니다. 필요한 상태를 아래처럼 캡처한 뒤 **에이전트가 이미지 도구로 직접 열어 확인합니다.**
파일명은 확인한 상태에 맞게 지정합니다.

```bash
qa_artifacts="$qa_root/evidence"
mkdir -p "$qa_artifacts"
curl --fail --silent "$qa_driver_url/session/$qa_session_id/screenshot" \
  | python3 -c 'import base64,json,sys; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["value"]))' \
  > "$qa_artifacts/observed.png"
```

DOM 변화만으로 화면이 보였다고 판단하지 않습니다. 스크린샷은 WebView 내용만 담습니다.
Rust IPC가 확인 범위에 포함되면 해당 UI 조작이나 필요한 IPC 요청의 실제 응답도 확인합니다.
응답 형식·수치처럼 코드로 확인할 수 있는 조건은 필요한 짧은 검사로 보완합니다.

## 종료

에이전트의 확인이 끝나면 세션을 닫고 이번에 시작한 PID만 종료합니다.

```bash
curl --fail --silent -X DELETE "$qa_driver_url/session/$qa_session_id"
kill -TERM "$qa_app_pid"
wait "$qa_app_pid"
```

QA 결과를 남긴 후 임시 빌드·상태를 필요에 따라 정리합니다. macOS AppData와 로그는
`qa-environment.json`의 고유 identifier로 구분됩니다. 상태 파일에는 임시 PC credential이
생길 수 있으므로 캡처·보고서·커밋에 넣지 않습니다. 원본 앱 데이터와 다른 실행 프로세스는 유지합니다.

결과는 대화로 요약하고 필요한 이미지·상세 보고서는 임시 파일 링크로 전달합니다.
재사용할 설치 환경 정보만 [로컬 QA 환경](reference-local-qa-environment.md)에 반영합니다.
