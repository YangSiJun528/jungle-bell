# 데스크톱 앱 상태 관리 참고 자료

> 문서 유형: 참조(reference)
>
> 확인일: 2026-07-26
>
> 대상: Jungle Bell의 Tauri v2 + Alpine.js 상태 관리

이 문서는 Jungle Bell의 상태 소유권을 확인하고, 이후 설계 변경 때 비교할 공식 문서와 실제 오픈소스 구현을 모아 둔 색인이다. 프로젝트 소스는 기본 브랜치 변경의 영향을 받지 않도록 확인한 커밋에 고정했다.

## 현재 구조

Jungle Bell은 Rust를 영속·런타임 상태의 기준으로 두고, 각 WebView의 Alpine 컴포넌트가 필요한 값을 복제해 표시하는 구조다.

| 범위 | 기준 상태 | 프런트엔드 표현 | 동기화 |
| --- | --- | --- | --- |
| 설정과 업데이트 배너 | [`SettingsService`](../src-tauri/src/settings_state.rs) + [`AppState`](../src-tauri/src/state.rs) | [`settings-state.ts`](../src/settings-state.ts)를 사용하는 [`settings.ts`](../src/settings.ts), [`onboarding.ts`](../src/onboarding.ts) | listener 등록 후 단일 snapshot 조회, 저장 성공 뒤 revision/source event |
| 출석, 체커, D-Day | [`AppState`](../src-tauri/src/state.rs) | 출석 창과 트레이 projection | Tauri command + domain event |
| 세탁·식단 캐시와 요청 제어 | [`CampusService`](../src-tauri/src/campus.rs) | [`campus.ts`](../src/campus.ts) | listener 등록 후 snapshot 요청, 이후 event |
| 소식 캐시 | [`NewsService`](../src-tauri/src/news.rs) | [`tray-panel.ts`](../src/tray-panel.ts) | command로 snapshot 조회 |
| 트레이 패널용 파생 상태 | [`TrayStateStore`](../src-tauri/src/tray.rs) | [`tray-panel.ts`](../src/tray-panel.ts) | command + window-targeted event |
| 탭, 메뉴, 로딩 등 화면 전용 상태 | 각 WebView | Alpine component | 해당 WebView 안에서만 유지 |
| 세탁기 필터 선호 | 브라우저 저장소 | Alpine component | `localStorage` |

기본 방향은 일반적인 Tauri 앱과 같다.

- OS 기능, 파일 저장, 백그라운드 작업에 영향을 주는 상태는 Rust가 소유한다.
- WebView는 Rust 상태의 화면용 projection을 가지며 `invoke`로 읽고 변경한다.
- 작은 비정기 변경은 event로 알리고, 창이 늦게 열리거나 event를 놓치는 경우를 위해 snapshot 조회 경로를 둔다.
- 탭, 펼침 상태, 일시적 입력처럼 한 화면에서만 의미가 있는 값은 프런트엔드에 남긴다.

Tauri 자체만을 위해서는 managed state에 `Arc`를 추가할 필요가 없다. 다만 Jungle Bell은 같은 값을 스케줄러와 업데이트 task에 직접 넘기기 위해 `Arc<Mutex<AppState>>`를 복제하므로 현재 `Arc`에는 별도 용도가 있다. 이것만으로 리팩터링할 이유는 없다.

현재 규모에서는 Redux, Zustand 같은 전역 프런트엔드 store를 추가할 근거도 약하다. Alpine store 역시 한 JavaScript 실행 환경 안의 전역 상태이므로 여러 WebView 사이의 기준 상태를 대신하지는 않는다.

### 설정 저장과 동기화 계약

현재 설정 변경은 다음 순서를 따른다.

1. `SettingsService`의 전용 async mutex가 writer 순서를 직렬화한다.
2. 현재 `Config`를 복제하고 복제본에 변경을 적용한 뒤 `AppState` 잠금을 해제한다.
3. 필요한 OS side effect를 준비하고, 원자적 파일 쓰기와 `fsync`는 blocking thread에서 실행한다.
4. 저장에 실패하면 준비한 OS side effect를 복구하고 command 오류를 반환한다. 메모리 설정과 revision은 바꾸지 않는다.
5. 저장에 성공한 경우에만 메모리 설정을 교체하고 revision을 올린 뒤 `settings`와 `onboarding` 창에 `settings-changed` snapshot을 보낸다.

프런트엔드는 event listener를 먼저 등록하고 `get_settings_snapshot`을 호출한다. snapshot과 event가 역순으로 도착해도 더 높은 revision만 적용한다. 저장 실패 뒤에는 같은 revision의 authoritative snapshot도 다시 투영해 시간·간격 필드를 포함한 optimistic UI를 복구한다.

트레이 패널 projection은 비동기 I/O가 없는 작은 메모리 상태다. `TrayStateStore`는 일반 mutex로 갱신을 짧게 직렬화하며, 잠금 경합을 이유로 변경을 버리지 않는다. 패널 snapshot을 복제하고 잠금을 해제한 뒤 WebView event와 OS 트레이 API를 호출한다.

## 관련 추적 이슈

검토에서 확인한 결함과 구현 범위는 참고 자료와 분리해 다음 이슈에서 추적한다.

- [#46 설정 저장 실패 전달과 파일 I/O 잠금 분리](https://github.com/YangSiJun528/jungle-bell/issues/46)
- [#47 단일 settings snapshot과 창 간 동기화](https://github.com/YangSiJun528/jungle-bell/issues/47)
- [#48 트레이 패널 projection의 변경 유실 방지](https://github.com/YangSiJun528/jungle-bell/issues/48)

## 공식 문서

### Tauri와 Rust

| 문서 | 확인할 내용 | Jungle Bell에서의 용도 |
| --- | --- | --- |
| [Tauri State Management](https://v2.tauri.app/develop/state-management/) | `manage`, `State`, interior mutability, async mutex, `Arc` 필요 여부 | Rust 상태 등록과 잠금 선택의 기준 |
| [Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/) | command 인자·반환값·오류 직렬화, async command | snapshot과 mutation API 계약 |
| [Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) | global/window event, listener 해제, event와 channel 차이 | 작은 상태 변경 통지와 창별 전달 |
| [Tauri Store plugin](https://v2.tauri.app/plugin/store/) | 영속 key-value store, 저장·불러오기 API | 단순 UI 선호 저장의 대안. OS side effect의 기준 상태로 바로 사용하지 않음 |
| [Tokio `Mutex`](https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html) | 일반 mutex와 async mutex의 선택, guard를 `await` 너머로 유지하는 경우 | 짧은 메모리 임계 구역과 async I/O 자원 구분 |

Tauri event는 작은 JSON payload와 다중 소비자 통지에 맞고, 저지연·고처리량 스트림에는 맞지 않는다. event에는 command 수준의 강한 타입과 capability 제어가 없으므로 payload 타입과 event 이름은 애플리케이션에서 별도로 관리해야 한다.

### Alpine.js

| 문서 | 확인할 내용 | 주의점 |
| --- | --- | --- |
| [`Alpine.data`](https://alpinejs.dev/globals/alpine-data) | 재사용 가능한 component state, `init`·`destroy` lifecycle | 현재 각 화면의 로컬 projection에 적합 |
| [`Alpine.store`](https://alpinejs.dev/globals/alpine-store) | 한 페이지의 global reactive state | 별도 WebView나 네이티브 상태를 자동 동기화하지 않음 |

### Electron

| 문서 | 확인할 내용 | Tauri와 대응되는 개념 |
| --- | --- | --- |
| [Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) | main·renderer·preload의 책임 | Rust core·WebView 경계 |
| [Inter-Process Communication](https://www.electronjs.org/docs/latest/tutorial/ipc) | `ipcMain.handle`/`ipcRenderer.invoke`, main→renderer message | Tauri command와 event |
| [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) | `contextBridge`로 제한된 API 노출 | Tauri command/capability 경계 |
| [`contextBridge` API](https://www.electronjs.org/docs/latest/api/context-bridge) | 안전한 preload facade 구성 | typed command wrapper 설계 |
| [Security](https://www.electronjs.org/docs/latest/tutorial/security) | IPC sender 검증, 원격 콘텐츠, 권한 최소화 | command scope와 remote WebView 검토 |

Electron에서도 main process가 네이티브 자원과 프로세스 공통 상태를 소유하고, renderer가 preload의 제한된 API를 통해 snapshot을 읽고 변경 알림을 받는 구성이 일반적이다.

### 큰 프런트엔드 store를 검토할 때

| 문서 | 적용 시점 |
| --- | --- |
| [RTK Query Overview](https://redux-toolkit.js.org/rtk-query/overview) | command 기반 조회가 많아져 캐시, invalidation, loading lifecycle의 중복이 커질 때 |
| [Jotai atom](https://jotai.org/docs/core/atom) | 큰 normalized snapshot에서 화면별 projection과 파생 값을 세밀하게 구독해야 할 때 |

둘 다 현재 Jungle Bell 설정 화면의 필수 의존성은 아니다. 아래 대형 프로젝트가 이 도구를 사용하는 이유는 상태 도메인과 화면 수가 훨씬 많기 때문이다.

## 오픈소스 프로젝트

선정 기준은 공개 소스, 최근 유지보수 활동, 실제 배포 앱, 상태 경계를 확인할 수 있는 코드다. 별 수는 인지도 확인용 보조 지표일 뿐 품질 판단 기준은 아니다.

| 프로젝트 | 규모·스택 | 확인 당시 유지보수 신호 | 핵심 패턴 |
| --- | --- | --- | --- |
| [OpenDeck](https://github.com/nekename/OpenDeck) | 소형~중형, Tauri + Svelte | 약 1.9k stars, v2.13.1(2026-06-27) | Rust의 전체 설정 snapshot + Svelte store |
| [Yaak](https://github.com/mountain-loop/yaak) | 중대형, Tauri + React | 약 18.9k stars, v2026.5.0(2026-07-21) | SQLite 기준 상태 + snapshot + change event + Jotai projection |
| [GitButler](https://github.com/gitbutlerapp/gitbutler) | 대형, Tauri/Svelte와 Electron/React 구현을 함께 운영 | 약 21.4k stars, 0.21.2(2026-07-22) | domain별 native service + settings watch + RTK Query 또는 typed preload |
| [Signal Desktop](https://github.com/signalapp/Signal-Desktop) | 대형, Electron + React | 약 16.4k stars, v8.20.0(2026-07-22) | main 설정 channel + 창 전체 변경 통지 + domain별 Redux reducer |

### OpenDeck: 전체 설정 snapshot

고정 소스: [`9787e4e`](https://github.com/nekename/OpenDeck/tree/9787e4ef3c09bdbfb668717978fd61ce05c6e383)

- [`Store<T>`](https://github.com/nekename/OpenDeck/blob/9787e4ef3c09bdbfb668717978fd61ce05c6e383/src-tauri/src/store/mod.rs)는 JSON 설정을 typed value로 감싸고 임시 파일·백업 파일을 거쳐 저장하며 `Result`를 반환한다.
- [`get_settings`/`set_settings`](https://github.com/nekename/OpenDeck/blob/9787e4ef3c09bdbfb668717978fd61ce05c6e383/src-tauri/src/events/frontend/settings.rs)는 필드별 command 대신 전체 `Settings` snapshot을 주고받는다.
- [Svelte settings store](https://github.com/nekename/OpenDeck/blob/9787e4ef3c09bdbfb668717978fd61ce05c6e383/src/lib/settings.ts)는 snapshot을 renderer reactive state로 투영한다.

참고할 부분은 작은 앱에서도 설정 타입과 저장 오류를 command 경계까지 유지한다는 점이다. 다만 전체 객체 자동 저장과 동기 파일 I/O를 그대로 복사하면 동시 writer나 event loop 지연 문제가 생길 수 있다.

### Yaak: snapshot + 변경 스트림

고정 소스: [`3f098f9`](https://github.com/mountain-loop/yaak/tree/3f098f95fe0b39650aee7de59b29a415df382872)

- [`QueryManager`](https://github.com/mountain-loop/yaak/blob/3f098f95fe0b39650aee7de59b29a415df382872/crates/yaak-models/src/query_manager.rs)는 내부 동기화가 있는 SQLite pool을 그대로 managed state로 사용한다.
- [Tauri model adapter](https://github.com/mountain-loop/yaak/blob/3f098f95fe0b39650aee7de59b29a415df382872/crates-tauri/yaak-app-client/src/models_ext.rs)는 창이 열릴 때 전체 workspace snapshot을 반환하고, 이후 `model_write` event를 모든 창에 전달한다.
- [Jotai model store](https://github.com/mountain-loop/yaak/blob/3f098f95fe0b39650aee7de59b29a415df382872/crates/yaak-models/guest-js/store.ts)는 snapshot으로 초기화한 뒤 upsert/delete event를 normalized projection에 적용한다. event에는 변경 출처와 workspace가 포함돼 불필요한 반영을 거른다.
- [영속 change log](https://github.com/mountain-loop/yaak/blob/3f098f95fe0b39650aee7de59b29a415df382872/crates/yaak-models/src/queries/model_changes.rs)는 CLI 같은 외부 writer의 변경까지 복구한다.

여러 창과 외부 writer가 있는 앱의 강한 예시다. Jungle Bell에는 DB change log가 과도하지만, **authoritative snapshot + source/revision이 있는 change event** 부분은 설정 동기화에 직접 참고할 수 있다.

### GitButler Tauri: domain별 state와 settings watch

고정 소스: [`952424f`](https://github.com/gitbutlerapp/gitbutler/tree/952424f43e25036f4e3afed2cc0248df40608c1f)

- [Tauri setup](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/crates/gitbutler-tauri/src/main.rs)은 `WindowState`, settings disk sync, watcher, feedback archival 등 수명주기가 다른 상태를 별도 managed service로 등록한다.
- [`WindowState`](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/crates/gitbutler-tauri/src/window.rs)는 window label별 watcher와 lock을 map으로 관리하고 창 제거 때 자원을 정리한다.
- [settings command](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/crates/gitbutler-tauri/src/settings.rs)는 typed update를 disk-sync service에 위임하고 저장 오류를 `Result`로 반환한다. disk watcher는 변경된 전체 settings를 `settings://update` event로 보낸다.
- [client state](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/desktop/src/lib/state/clientState.svelte.ts)와 [backend API](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/desktop/src/lib/state/backendApi.ts)는 UI state와 backend query cache를 분리한다.

참고할 부분은 하나의 거대한 state가 아니라 수명주기·동시성·도메인이 다른 자원을 service로 분리하는 기준이다. RTK Query 구성 전체는 Jungle Bell의 현재 command 수와 화면 규모에는 맞지 않는다.

### GitButler Lite: Electron main + typed preload

같은 저장소의 Electron 구현은 Tauri와 Electron의 대응 관계를 비교하기 좋다.

- [main IPC 등록](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/lite/electron/src/main.ts)은 native SDK와 watcher를 main process에 둔다.
- [typed preload facade](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/lite/electron/src/preload.cts)는 command별 메서드와 명시적인 subscribe/unsubscribe API만 renderer에 노출한다.
- [GUI settings](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/lite/electron/src/settings.ts)는 version·runtime validation·migration·atomic write를 한 모듈에서 처리한다.
- [`WatcherManager`](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/lite/electron/src/watcher.ts)는 여러 창의 구독을 deduplicate하고 renderer 종료 때 subscription을 정리한다.
- [renderer Redux store](https://github.com/gitbutlerapp/gitbutler/blob/952424f43e25036f4e3afed2cc0248df40608c1f/apps/lite/ui/src/store.ts)는 renderer 전용 interface/project state만 관리한다.

Tauri의 command는 `ipcMain.handle`/`ipcRenderer.invoke`, event listener는 preload의 subscribe/unsubscribe facade에 대응한다.

### Signal Desktop: 대규모 Electron의 domain 분리

고정 소스: [`5bb3679`](https://github.com/signalapp/Signal-Desktop/tree/5bb36790e7007474995a804dee47473a35e30df0)

- [`SettingsChannel`](https://github.com/signalapp/Signal-Desktop/blob/5bb36790e7007474995a804dee47473a35e30df0/ts/main/settingsChannel.main.ts)는 main-owned 설정을 IPC get/set handler로 노출하고 변경 값을 window에 push한다.
- [main process](https://github.com/signalapp/Signal-Desktop/blob/5bb36790e7007474995a804dee47473a35e30df0/app/main.main.ts)는 `preferences-changed`를 active window 전체에 전달해 각 창이 설정을 다시 읽게 한다.
- [Redux reducer](https://github.com/signalapp/Signal-Desktop/blob/5bb36790e7007474995a804dee47473a35e30df0/ts/state/reducer.preload.ts)는 대화, 통화, 업데이트, 네트워크, UI modal 등 독립 domain을 결합한다.
- [초기 Redux 구성](https://github.com/signalapp/Signal-Desktop/blob/5bb36790e7007474995a804dee47473a35e30df0/ts/state/initializeRedux.preload.ts)은 native·DB에서 모은 초기 snapshot으로 renderer store를 만든다.

Signal의 Redux 규모는 그대로 가져올 대상이 아니다. 여러 창에 변경 사실을 통지하고 각 창이 authoritative snapshot으로 복구하는 구조만 비교 대상으로 삼는다.

## 패턴 비교

| 패턴 | OpenDeck | Yaak | GitButler | Signal Desktop | Jungle Bell |
| --- | --- | --- | --- | --- | --- |
| native/main 기준 상태 | Rust JSON store | Rust + SQLite | Rust service / Electron main | Electron main + DB | Rust `AppState`와 service |
| 초기 snapshot | 전체 settings | workspace models | settings/query별 | Redux init data | typed `SettingsSnapshot`과 domain별 snapshot |
| 변경 통지 | 제한적 | typed model event | settings/watcher event | settings/preferences IPC | revision/source settings event와 campus/login/tray event |
| renderer projection | Svelte store | Jotai normalized store | RTK Query + Redux | domain별 Redux | window별 Alpine component |
| 저장 오류 전달 | `Result` | DB `Result`/transaction | `Result`/rejected Promise | IPC별 처리 | atomic save `Result`를 command까지 전달 |

## Jungle Bell에 적용할 기준

1. Rust를 영속 설정과 OS side effect의 기준 상태로 유지한다.
2. 읽어야 할 설정이 한 묶음이면 필드별 command보다 typed snapshot 하나를 우선한다.
3. 여러 창이 같은 값을 표시하면 snapshot을 복구 경로로 두고, 저장 성공 뒤 revision 또는 source를 포함한 event를 보낸다.
4. event 자체를 기준 상태로 삼지 않는다. 늦게 열린 창과 놓친 event는 snapshot으로 수렴해야 한다.
5. 파일 저장 성공 여부와 command 성공 여부를 일치시킨다.
6. 동기 파일 I/O는 async mutex guard를 잡은 채 실행하지 않는다. 잠금 밖으로 옮길 때는 write 순서가 뒤집히지 않도록 단일 writer나 revision 검증을 둔다.
7. 화면 하나에만 필요한 값은 Alpine component나 `localStorage`에 남긴다.
8. 외부 writer, 대규모 query cache, 복잡한 optimistic update가 생기기 전에는 DB change log나 Redux/RTK Query를 도입하지 않는다.

## 갱신 규칙

- 공식 문서는 latest URL을 유지한다.
- 프로젝트 구현 링크는 검토한 commit에 고정한다.
- 프로젝트의 최신 구현을 다시 검토했을 때만 고정 commit과 유지보수 신호를 함께 갱신한다.
- 특정 구현을 정답으로 기록하지 않고, 가져올 패턴과 규모상 제외할 부분을 함께 남긴다.
