# hidden checker WebView 공개 앱 패턴 참고

문서 유형: explanation.

## 목적

Jungle Bell의 "로그인 상태인데도 트레이 아이콘이 노란색으로 남는 문제"를 더 일반적인 앱 아키텍처 문제로 정리하고, 공개된 실제 앱들이 유사 문제를 어떻게 줄이는지 비교한다.

핵심 관심사는 hidden checker WebView 자체가 아니라 다음 구조다.

- native host가 별도 실행 주체를 만든다.
- 그 실행 주체가 웹 페이지, renderer, daemon, actor, extension host, WebView bridge 중 하나다.
- host UI 또는 tray 상태는 그 실행 주체의 report에 의존한다.
- host가 `loaded`, `URL changed`, `object exists`, `session exists` 같은 약한 신호를 상태 보고로 오해하면 stale UI가 남는다.

## 핵심 주장

Tauri 공개 실제 서비스 앱 중에 Jungle Bell처럼 hidden authenticated checker WebView를 운영하는 가까운 사례는 찾기 어려웠다. 하지만 Tauri라고 원리가 달라지지 않는다.

Tauri도 WebView2, WebKit, Wry 위에서 돌아가므로 Rust 쪽은 URL load만으로 injected JS 실행 여부를 알 수 없다. 따라서 Electron 쪽에서 반복적으로 보이는 패턴인 explicit ready IPC, timeout, recreate를 앱 레벨에서 구현해야 한다.

## 조사 범위

실제 서비스 앱을 우선했다. 라이브러리나 프레임워크 문서는 보조 근거로만 보았다.

비교 순서:

1. Electron/Tauri WebView 앱
2. 모바일 WebView/hybrid 앱
3. 데스크톱 background/tray 앱
4. WebView는 아니지만 같은 "별도 실행 주체의 readiness" 문제를 가진 앱

확인한 주요 공개 저장소:

- VS Code: <https://github.com/microsoft/vscode>
- Mattermost Desktop: <https://github.com/mattermost/desktop>
- Element Desktop: <https://github.com/element-hq/element-desktop>
- Rocket.Chat Desktop: <https://github.com/RocketChat/Rocket.Chat.Electron>
- Zulip Desktop: <https://github.com/zulip/zulip-desktop>
- Signal Desktop: <https://github.com/signalapp/Signal-Desktop>
- lencx/ChatGPT: <https://github.com/lencx/ChatGPT>
- Spacedrive: <https://github.com/spacedriveapp/spacedrive>
- Home Assistant Android: <https://github.com/home-assistant/android>
- WordPress Android: <https://github.com/wordpress-mobile/WordPress-Android>
- Moodle App: <https://github.com/moodlehq/moodleapp>
- Nextcloud Desktop: <https://github.com/nextcloud/desktop>
- Syncthing Tray: <https://github.com/Martchus/syncthingtray>

## Jungle Bell 문제의 일반형

Jungle Bell의 실패는 다음처럼 일반화할 수 있다.

```text
host/native process
  -> creates hidden observer runtime
  -> observer loads authenticated web page
  -> injected script should report status
  -> host updates tray from report

failure:
  page/session appears valid
  but injected script does not run or does not report
  host keeps stale initial UI state
```

약한 신호:

- WebView 객체가 존재한다.
- page load event가 왔다.
- URL이 `/login` 또는 `/check-in`으로 바뀌었다.
- cookie/session storage가 있다.
- `trigger_check` timer가 돌고 있다.

강한 신호:

- injected script가 로드됐다고 host에 명시 보고했다.
- 현재 WebView generation에서 status payload가 host에 도착했다.
- host가 제한 시간 안에 report를 받았다.
- 실패 시 host가 unknown/error/recovering으로 전환하고 reload 또는 recreate를 수행했다.

## 공개 앱 비교

| 앱 | 분류 | 구체 패턴 | Jungle Bell 시사점 |
| --- | --- | --- | --- |
| VS Code | Electron, Webview, extension host | Webview iframe이 [`webview-ready`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html#L325-L328)를 보낸 뒤 host가 ready로 전환한다. Extension host는 [`ready` 메시지 60초 timeout](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts#L465-L474)을 둔다. Crash는 [제한적으로 자동 재시작하고 3회/5분 이후 사용자 액션](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts#L183-L225)으로 넘긴다. | 가장 강한 기준점이다. `page loaded`와 `checker.js/report ready`를 분리해야 한다. |
| Mattermost Desktop | Electron, WebContentsView | preload API가 [`REACT_APP_INITIALIZED`](https://github.com/mattermost/desktop/blob/master/src/app/preload/externalAPI.ts#L75-L78)를 보낸다. WebContents는 [`render-process-gone`](https://github.com/mattermost/desktop/blob/master/src/app/views/webContentEvents.ts#L333-L339)을 감지한다. metrics 요청은 [5초 timeout](https://github.com/mattermost/desktop/blob/master/src/main/performanceMonitor.ts#L123-L150)을 둬서 응답 없는 view가 전체 흐름을 막지 않게 한다. | hidden checker가 응답하지 않으면 단순 trigger 반복이 아니라 timeout 기반 복구가 필요하다. |
| Element Desktop | Electron | preload가 [`initialise`](https://github.com/element-hq/element-desktop/blob/develop/src/preload.cts#L54-L70)를 발생시키고 main이 [`ipcMain.once("initialise")`](https://github.com/element-hq/element-desktop/blob/develop/src/ipc.ts#L222-L227)로 한 번만 ready를 받는다. | 최소형 ready handshake다. Jungle Bell의 `report_checker_ready`와 같은 범주다. |
| Rocket.Chat Desktop | Electron, 서버별 WebView | preload가 서버 URL과 renderer store를 준비한 뒤 [`server-view/ready`](https://github.com/RocketChat/Rocket.Chat.Electron/blob/master/src/preload.ts#L37-L68)를 호출한다. 서버 WebView는 [`did-attach`와 `dom-ready`를 모두 받은 뒤 WEBVIEW_READY](https://github.com/RocketChat/Rocket.Chat.Electron/blob/master/src/ui/components/ServersView/ServerPane.tsx#L70-L102) 처리한다. deep link는 [webContents polling + timeout](https://github.com/RocketChat/Rocket.Chat.Electron/blob/master/src/deepLinks/main.ts#L134-L164)을 둔다. video-call WebView는 [`renderer-ready`, `webview-ready`, `webview-failed`](https://github.com/RocketChat/Rocket.Chat.Electron/blob/master/src/ipc/channels.ts#L44-L56)를 분리한다. | Jungle Bell과 매우 가깝다. 다만 `dom-ready`만으로 injected checker 실행을 보장하지는 못하므로 Jungle Bell은 추가 ack가 필요하다. |
| Zulip Desktop | Electron WebView wrapper | `dom-ready`에서 loading을 내리고, [`did-fail-load`의 connectivity error](https://github.com/zulip/zulip-desktop/blob/main/app/renderer/js/components/webview.ts#L175-L190)를 감지한다. reconnect는 [Fibonacci backoff 후 online이면 reload](https://github.com/zulip/zulip-desktop/blob/main/app/renderer/js/utils/reconnect-util.ts#L21-L68)한다. | 네트워크 복구에는 충분하지만, injected script report 누락 문제에는 약하다. |
| lencx/ChatGPT | Tauri, remote WebView wrapper | ChatGPT remote WebView에 [`initialization_script`](https://github.com/lencx/ChatGPT/blob/v2-dev/src-tauri/src/core/setup.rs#L56-L94)를 주입하고 URL change를 titlebar에 emit한다([INIT_SCRIPT](https://github.com/lencx/ChatGPT/blob/v2-dev/src-tauri/src/core/constant.rs#L6-L13)). | 실제 Tauri remote WebView 사례지만 ready ack나 watchdog은 보이지 않는다. Jungle Bell 같은 hidden checker에는 부족하다. |
| Home Assistant Android | Android WebView app | [`onPageFinished`](https://github.com/home-assistant/android/blob/main/app/src/main/kotlin/io/homeassistant/companion/android/util/HAWebViewClient.kt#L102-L105), [`onReceivedError`](https://github.com/home-assistant/android/blob/main/app/src/main/kotlin/io/homeassistant/companion/android/util/HAWebViewClient.kt#L126-L137), [`onRenderProcessGone`](https://github.com/home-assistant/android/blob/main/app/src/main/kotlin/io/homeassistant/companion/android/util/HAWebViewClient.kt#L252-L255)를 분리한다. ViewModel은 [WebView load timeout](https://github.com/home-assistant/android/blob/main/app/src/main/kotlin/io/homeassistant/companion/android/frontend/FrontendViewModel.kt#L673-L686)을 error로 전환한다. | 모바일 WebView도 "load", "error", "renderer gone", "timeout"을 분리한다. |
| WordPress Android | Android WebView | `ErrorManagedWebViewClient`가 [`onPageStarted`에서 error flag를 reset하고 main-frame error만 실패로 처리](https://github.com/wordpress-mobile/WordPress-Android/blob/trunk/WordPress/src/main/java/org/wordpress/android/util/ErrorManagedWebViewClient.kt#L15-L37)한다. ViewModel은 [network availability에 따라 progress/error](https://github.com/wordpress-mobile/WordPress-Android/blob/trunk/WordPress/src/main/java/org/wordpress/android/viewmodel/wpwebview/WPWebViewViewModel.kt#L74-L109)로 시작하고 [loadNeeded](https://github.com/wordpress-mobile/WordPress-Android/blob/trunk/WordPress/src/main/java/org/wordpress/android/viewmodel/wpwebview/WPWebViewViewModel.kt#L121-L154)를 재발행한다. | subresource error와 main-frame error를 구분한다. checker도 "URL 관찰"과 "상태 보고"를 구분해야 한다. |
| Moodle App | Ionic/Capacitor hybrid | bootstrap을 [`CorePlatform.ready()`](https://github.com/moodlehq/moodleapp/blob/main/src/core/initializers/wait-for-platform-ready.ts#L20-L22), DB 초기화, 서비스 초기화, [session restore](https://github.com/moodlehq/moodleapp/blob/main/src/core/initializers/restore-session.ts#L21-L24)로 나눈다. reconnect 시 [network handlers를 재시작](https://github.com/moodlehq/moodleapp/blob/main/src/core/initializers/watch-network.ts#L22-L27)한다. | WebView 자체 callback보다 앱 초기화 barrier가 핵심이다. Jungle Bell도 checker report 전까지는 상태 확정으로 보면 안 된다. |
| Nextcloud Desktop | native background/tray app | `AccountState`가 [`SignedOut`, `Disconnected`, `Connected`, `ServiceUnavailable`, `NetworkError`](https://github.com/nextcloud/desktop/blob/master/src/gui/accountstate.h#L44-L80) 등을 분리한다. `ConnectionValidator`는 [`CredentialsWrong`, `ServiceUnavailable`, `Timeout`](https://github.com/nextcloud/desktop/blob/master/src/gui/connectionvalidator.h#L109-L123)을 별도 결과로 낸다. tray sync icon은 [connection 없음이면 offline](https://github.com/nextcloud/desktop/blob/master/src/gui/tray/usermodel.cpp#L165-L169), error/warning/paused/syncing/success를 [우선순위로 접는다](https://github.com/nextcloud/desktop/blob/master/src/gui/tray/usermodel.cpp#L238-L254). | tray 앱에서는 unknown/offline/error를 명시 상태로 둔다. 초기 warning을 상태 미확인과 섞으면 stale 문제가 생긴다. |
| Syncthing Tray | native background/tray app | 상태 enum이 [`Disconnected`, `Reconnecting`, `Idle`, `Scanning`, `Synchronizing`](https://github.com/Martchus/syncthingtray/blob/master/syncthingconnector/syncthingconnectionstatus.h#L19-L29) 등으로 분리된다. tray icon은 [`statusChanged`, reconnect interval, device status](https://github.com/Martchus/syncthingtray/blob/master/tray/gui/trayicon.cpp#L95-L123)에 연결된다. status text는 [reconnecting, reconnect interval, unknown](https://github.com/Martchus/syncthingtray/blob/master/syncthingwidgets/misc/statusinfo.cpp#L36-L115)을 표시한다. | warning이 아니라 reconnecting/unknown을 따로 보여준다. stale 노란 아이콘 문제의 반례다. |
| Signal Desktop | Electron main/renderer/tray | shutdown 시 renderer ack인 `now-ready-for-shutdown`을 기다리지만, listener가 아직 없을 수 있어 [2분 timeout 후 강제 진행](https://github.com/signalapp/Signal-Desktop/blob/main/app/main.main.ts#L2539-L2574)한다. tray는 [enabled와 BrowserWindow 존재 조건](https://github.com/signalapp/Signal-Desktop/blob/main/app/SystemTrayService.main.ts#L79-L104)을 만족할 때만 render한다. | WebView는 아니지만 "renderer listener가 아직 없을 수 있다"는 실패 모델을 명시 처리한다. |
| Spacedrive | Tauri UI + Rust core/daemon | Tauri event 구독은 [listen을 먼저 붙이고 subscribe를 invoke](https://github.com/spacedriveapp/spacedrive/blob/main/packages/ts-client/src/transport.ts#L53-L87)해 초기 이벤트 유실을 막는다. Actor manager는 [already running 방지와 invalidate signal](https://github.com/spacedriveapp/spacedrive/blob/main/crates/actors/src/lib.rs#L172-L224)을 두고, stop은 [1분 timeout 후 abort](https://github.com/spacedriveapp/spacedrive/blob/main/crates/actors/src/lib.rs#L332-L350)한다. | producer가 먼저 이벤트를 보내고 consumer가 늦게 붙는 race를 피한다. checker ready race와 같은 일반형이다. |

## 반복되는 해결 패턴

### 1. explicit ready IPC

대부분의 견고한 앱은 "페이지가 로드됐다"가 아니라 "내가 준비됐다"라는 별도 IPC를 둔다.

Jungle Bell 기준으로는 다음이 다르다.

- `checker page loaded`: 약한 신호
- `checker.js loaded`: injected script 실행 신호
- `report_attendance_status`: 실제 상태 신호

따라서 Rust 쪽 상태 전환은 `page loaded`가 아니라 `report_attendance_status` 기준이어야 한다.

### 2. timeout과 failure state

공개 앱들은 ready/report가 오지 않는 경우를 정상 흐름으로 취급한다.

- VS Code: ready message timeout
- Mattermost: metrics response timeout
- Rocket.Chat: webContents polling timeout, video-call init retry
- Home Assistant: WebView loading timeout
- Signal: renderer shutdown ack timeout
- Syncthing Tray: reconnect interval 표시

Jungle Bell에서는 checker page-load 후 일정 시간 안에 첫 report가 없으면 `trigger_check`만 반복하지 말고 watchdog으로 복구해야 한다.

### 3. reload보다 recreate가 필요한 경우

단순 reload는 JavaScript listener가 이미 죽었거나 initialization script가 주입되지 않은 경우 충분하지 않을 수 있다.

Jungle Bell의 재현 로그는 다음 상태였다.

- URL은 `/login` 또는 `/check-in`까지 이동했다.
- `trigger_check`는 반복됐다.
- `checker.js loaded`가 없었다.
- report도 없었다.

이 상태에서는 listener가 없으므로 `trigger_check`가 의미 없다. WebView 객체를 다시 만드는 recreate가 더 적절하다.

### 4. unknown/loading 상태

Nextcloud와 Syncthing Tray는 연결 전, 재연결 중, unknown, error를 다른 상태로 둔다. WordPress와 Home Assistant도 loading/error/content를 분리한다.

Jungle Bell에서 초기 tray icon을 warning으로 두면, 첫 report가 없을 때 "로그인 필요"처럼 보이는 stale state가 된다.

더 안전한 상태 모델:

```text
Unknown/Loading
  -> NeedsLogin
  -> AttendanceCheckedIn
  -> AttendancePending
  -> Recovering
  -> Error/GiveUp
```

### 5. generation과 stale report 무시

watchdog이 WebView를 recreate하면 이전 WebView에서 늦게 도착한 report가 있을 수 있다. 따라서 generation 또는 instance id가 필요하다.

VS Code의 webview id/message port, Rocket.Chat의 webContentsId, Nextcloud/Syncthing의 connection object state는 모두 같은 목적을 가진다. 현재 인스턴스에서 온 신호만 신뢰해야 한다.

### 6. retry limit 또는 backoff

복구는 무한 즉시 재시도가 아니어야 한다.

- VS Code는 extension host crash가 반복되면 사용자에게 넘긴다.
- Zulip은 Fibonacci backoff를 쓴다.
- Nextcloud는 retry count와 delay를 둔다.
- Syncthing Tray는 reconnect interval을 상태에 표시한다.

Jungle Bell도 checker recreate 횟수 제한, backoff, give-up 상태가 필요하다.

## Tauri에 대한 결론

Tauri에서는 Rust가 WebView lifecycle을 소유하지만, DOM 내부에서 injected script가 실행됐는지는 Rust가 자동으로 알 수 없다. URL load callback이나 WebView 객체 존재는 충분하지 않다.

따라서 Tauri hidden checker WebView에는 다음 앱 레벨 계약이 필요하다.

1. WebView를 만들 때 generation을 증가시킨다.
2. injected script 시작 시 `checker_ready(generation)`을 보낸다.
3. 실제 상태 확인 후 `attendance_status(generation, payload)`를 보낸다.
4. host는 현재 generation의 report만 신뢰한다.
5. page-load 후 timeout 안에 report가 없으면 WebView를 recreate한다.
6. recreate가 반복되면 recovering/error/give-up 상태로 tray에 표시한다.
7. 첫 report 전에는 로그인 경고 아이콘을 표시하지 않는다.

## Jungle Bell 현재 수정과의 대응

현재 적용된 수정은 공개 앱 패턴과 같은 방향이다.

- checker ready/report 세대를 추적한다.
- `checker.js loaded`를 Rust로 보고한다.
- 첫 report가 일정 시간 안에 없으면 watchdog이 WebView를 재생성한다.
- 첫 report 전 macOS Dock/Accessory 전환을 늦춘다.
- 초기/복구중/확인불가 tray icon을 warning이나 normal이 아닌 gray offline/loading 상태로 둔다.
- report가 없는 상태에서 stale warning icon이 남는 경로를 줄인다.

## 아직 남은 리스크

- 공개 Tauri 앱 중 Jungle Bell과 동일한 "hidden authenticated checker WebView" 사례는 찾지 못했다.
- Tauri/Wry/WebKit의 내부 content process 종료와 initialization script 재주입 조건은 앱 코드 비교만으로 확정할 수 없다.
- 현재 수동 검증에서는 watchdog recreate가 실제 장애 주입으로 발동된 사례가 아니라 정상화 사례 위주로 확인됐다.
- WebView recreate 후 세션 storage/cookie가 항상 기대대로 유지되는지는 더 긴 soak test가 필요하다.

## 후속 개선 후보

- checker no-report를 강제로 만드는 debug flag를 추가한다.
- watchdog recreate 통합 테스트를 수동이 아니라 스크립트화한다.
- tray tooltip 또는 debug menu에 `loading`, `ready-wait`, `report-wait`, `recreating`, `give-up`을 표시한다.
- JS에서 generation을 함께 보내 현재 generation 판정을 더 엄격히 한다.
- macOS ActivationPolicy 전환 전후로 checker ready/report latency를 계측한다.
