# checker 세션 백업/복구 재현 플로우

문서 유형: how-to guide.

이 문서는 Jungle Bell의 hidden checker WebView가 로그인 상태를 보고하지 못해
트레이 아이콘이 노란색으로 남는 문제를 재현/분석하기 위한 절차다.

목표는 비밀번호를 저장하지 않고, macOS WebKit 세션 저장소를 스냅샷으로 보관해
필요할 때 같은 로그인 상태를 복구하는 것이다. 세션 파일에는 인증 쿠키/토큰이
포함될 수 있으므로 절대 커밋하거나 채팅/이슈에 내용을 붙여 넣지 않는다.

## 현재 관찰

2026-07-07 로컬 로그 기준:

- `v0.3.7-beta.0` 첫 실행에서는 `checker.js loaded`와
  `report: needs_login=false`가 정상 기록됨.
- 이후 실행에서는 앱 시작 로그와 `attendance window closed, reloading checker`
  로그는 있으나 `checker.js loaded` / `report: needs_login=...`가 없음.
- 따라서 "실제로 로그인되어 있는데 로그인 필요로 오판"이라기보다,
  checker WebView가 상태 보고를 하지 못해 초기 노란 아이콘이 그대로 남는
  가능성이 높다.

관련 코드:

- 초기 트레이 아이콘은 노란색으로 시작한다:
  `src-tauri/src/tray.rs`의 `TrayIconBuilder::icon(ICON_WARNING)`.
- 실제 아이콘 변경은 checker 보고 이후 `tray::update_tray()`에서 발생한다.
- macOS Dock 숨김은 `ActivationPolicy::Accessory`와 `set_dock_visibility(false)`를
  사용한다.

## 세션 저장소 후보

macOS Tauri/WKWebView 기준으로 확인된 후보:

필수 후보:

```text
~/Library/HTTPStorages/jungle-bell.binarycookies
~/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies
~/Library/WebKit/jungle-bell
~/Library/WebKit/dev.sijun-yang.jungle-bell
```

보조 후보:

```text
~/Library/Caches/jungle-bell
~/Library/Caches/dev.sijun-yang.jungle-bell
```

앱 설정:

```text
~/Library/Application Support/jungle-bell/config.json
```

설정 파일은 로그인 세션 자체는 아니므로 기본 백업 대상에서 제외한다.

## 스냅샷 생성

가능하면 앱을 종료한 상태에서 실행한다. 실행 중에도 복사할 수는 있지만, WebKit
SQLite/WAL 파일이 쓰는 중이면 스냅샷이 일관되지 않을 수 있다.

```bash
mkdir -p /private/tmp/jungle-bell-session-backups

ts=$(date +%Y%m%d-%H%M%S)
archive="/private/tmp/jungle-bell-session-backups/session-$ts.tgz"

tar -czf "$archive" -C / \
  Users/sijun-yang/Library/WebKit/jungle-bell \
  Users/sijun-yang/Library/WebKit/dev.sijun-yang.jungle-bell \
  Users/sijun-yang/Library/HTTPStorages/jungle-bell.binarycookies \
  Users/sijun-yang/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies \
  Users/sijun-yang/Library/Caches/jungle-bell \
  Users/sijun-yang/Library/Caches/dev.sijun-yang.jungle-bell

chmod 600 "$archive"
shasum -a 256 "$archive"
tar -tzf "$archive" | wc -l
```

2026-07-07 실험 결과:

- archive: `/private/tmp/jungle-bell-session-backups/session-20260707-230824.tgz`
- size: `8.9M`
- mode: `600`
- entries: `954`
- sha256:
  `546a278db4e0334272fb8ba2ed8b5f36fd3231dbafa1ab5e72b4abc4f7b7e632`

이 archive는 인증 세션을 포함할 수 있다. 외부 공유 금지.

## dry-run 복구 검증

실제 앱 저장소를 건드리지 않고 archive 구조만 확인한다.

```bash
restore_root="/private/tmp/jungle-bell-session-restore-dry-run"
rm -rf "$restore_root"
mkdir -p "$restore_root"

tar -xzf "$archive" -C "$restore_root"

test -d "$restore_root/Users/sijun-yang/Library/WebKit/jungle-bell"
test -d "$restore_root/Users/sijun-yang/Library/WebKit/dev.sijun-yang.jungle-bell"
test -f "$restore_root/Users/sijun-yang/Library/HTTPStorages/jungle-bell.binarycookies"
test -f "$restore_root/Users/sijun-yang/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies"
```

2026-07-07 dry-run 결과: 네 항목 모두 존재 확인.

## 실제 테스트 결과

2026-07-07에 실제 세션 제거/복구 테스트를 수행했다. 세션 값은 확인하거나
출력하지 않았고, 파일 이동/복구와 앱 로그만 확인했다.

테스트 전 상태:

- 앱 프로세스: `target/debug/jungle-bell` PID `2709`
- 종료 후 세션 파일 이동 진행

세션 제거:

- 기존 세션 후보를 다음 rollback 디렉터리로 이동:
  `/private/tmp/jungle-bell-session-live-test/no-session-rollback-20260707-231637`
- 이동 대상:
  - `~/Library/WebKit/jungle-bell`
  - `~/Library/WebKit/dev.sijun-yang.jungle-bell`
  - `~/Library/HTTPStorages/jungle-bell.binarycookies`
  - `~/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies`
  - `~/Library/Caches/jungle-bell`
  - `~/Library/Caches/dev.sijun-yang.jungle-bell`

세션 제거 후 앱 실행 결과:

```text
23:16:48 app starting v0.3.7-beta.0
23:16:49 web content process terminated
23:16:50 checker page loaded: https://jungle-lms.krafton.com/login
23:16:50 checker trigger_check emitted
23:16:54..23:17:29 scheduler tick + trigger_check 반복
```

관찰:

- 세션 제거는 실제로 `/login` 상태를 재현했다.
- 그러나 `checker.js loaded` 로그가 없었다.
- `report: needs_login=true`도 없었다.
- 즉, 로그인 필요 상태를 보고하는 대신 checker initialization script 자체가 실행되지
  않는 상태가 재현됐다.

세션 복구:

- 세션 제거 상태에서 새로 생긴 WebKit 파일을 다음 디렉터리로 이동:
  `/private/tmp/jungle-bell-session-live-test/no-session-generated-20260707-231759`
- 기존 snapshot에서 복구:
  `/private/tmp/jungle-bell-session-backups/session-20260707-230824.tgz`

복구 후 앱 실행 결과:

```text
23:18:09 app starting v0.3.7-beta.0
23:18:09 web content process terminated
23:18:10 checker page loaded: https://jungle-lms.krafton.com/check-in
23:18:10 checker trigger_check emitted
23:18:14..23:19:09 scheduler tick + trigger_check 반복
```

관찰:

- snapshot 복구는 WebView URL을 `/login`에서 `/check-in`으로 되돌렸다.
- 따라서 로그인 세션 복구 자체는 부분적으로 성공했다.
- 하지만 복구 후에도 `checker.js loaded`와 `report: needs_login=false`가 없었다.
- 결론: 현재 문제는 세션 백업/복구만으로 해결되지 않는다. 핵심은 hidden checker
  WebView에서 initialization script가 실행되지 않거나, 실행 로그/IPC가 끊기는 문제다.

## 실제 복구 절차

실제 복구는 현재 WebKit 세션을 덮어쓴다. 반드시 앱을 종료하고, 기존 상태를
rollback 디렉터리로 이동한 뒤 진행한다.

```bash
archive="/private/tmp/jungle-bell-session-backups/session-YYYYMMDD-HHMMSS.tgz"
restore_root="/private/tmp/jungle-bell-session-restore"
rollback_root="/private/tmp/jungle-bell-session-rollback-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$restore_root" "$rollback_root"
tar -xzf "$archive" -C "$restore_root"

mkdir -p "$rollback_root/Library/WebKit" "$rollback_root/Library/HTTPStorages" "$rollback_root/Library/Caches"

mv "$HOME/Library/WebKit/jungle-bell" "$rollback_root/Library/WebKit/" 2>/dev/null || true
mv "$HOME/Library/WebKit/dev.sijun-yang.jungle-bell" "$rollback_root/Library/WebKit/" 2>/dev/null || true
mv "$HOME/Library/HTTPStorages/jungle-bell.binarycookies" "$rollback_root/Library/HTTPStorages/" 2>/dev/null || true
mv "$HOME/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies" "$rollback_root/Library/HTTPStorages/" 2>/dev/null || true
mv "$HOME/Library/Caches/jungle-bell" "$rollback_root/Library/Caches/" 2>/dev/null || true
mv "$HOME/Library/Caches/dev.sijun-yang.jungle-bell" "$rollback_root/Library/Caches/" 2>/dev/null || true

mkdir -p "$HOME/Library/WebKit" "$HOME/Library/HTTPStorages" "$HOME/Library/Caches"

ditto "$restore_root/Users/sijun-yang/Library/WebKit/jungle-bell" "$HOME/Library/WebKit/jungle-bell"
ditto "$restore_root/Users/sijun-yang/Library/WebKit/dev.sijun-yang.jungle-bell" "$HOME/Library/WebKit/dev.sijun-yang.jungle-bell"
ditto "$restore_root/Users/sijun-yang/Library/HTTPStorages/jungle-bell.binarycookies" "$HOME/Library/HTTPStorages/jungle-bell.binarycookies"
ditto "$restore_root/Users/sijun-yang/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies" "$HOME/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies"
ditto "$restore_root/Users/sijun-yang/Library/Caches/jungle-bell" "$HOME/Library/Caches/jungle-bell"
ditto "$restore_root/Users/sijun-yang/Library/Caches/dev.sijun-yang.jungle-bell" "$HOME/Library/Caches/dev.sijun-yang.jungle-bell"
```

복구 후 앱을 실행하고 로그에서 다음을 확인한다.

```text
[checker:js] checker.js loaded, running initial check
[checker] report: needs_login=false
```

## 재현 실험 플로우

로그인 세션이 있는 상태에서:

1. 앱 종료.
2. 위 절차로 logged-in snapshot 생성.
3. 현재 세션 디렉터리를 rollback 위치로 이동해 세션이 없는 상태를 만든다.
4. 앱 실행.
5. 기대 결과:
   - checker가 로그인 필요를 보고하거나,
   - checker report가 아예 없으면 초기 노란 아이콘이 유지된다.
6. 앱 종료.
7. snapshot 복구.
8. 앱 실행.
9. 기대 결과:
   - `checker.js loaded`
   - `report: needs_login=false`
   - 트레이 아이콘이 노란색에서 정상 상태로 변경된다.

## 문제 해결 후보

우선순위:

1. checker initialization script 미실행을 직접 감지하고 복구한다.
   - page-load 후 5초 내 `report_attendance_status`가 없으면 `checker` WebView를
     재생성하거나 reload한다.
   - 단순 `trigger_check` 반복은 효과가 없었다. 이벤트 수신 JS가 로드되지 않았기
     때문이다.
2. checker 첫 report 전에는 Dock 숨김을 지연한다.
   - `build_checker_window()` 직후 바로 `sync_foreground_app_visibility()`를 호출하지 않는다.
   - 첫 `report_attendance_status` 수신 후 foreground window가 없으면 숨긴다.
3. checker reload 후 일정 시간 report가 없으면 강제 재시도한다.
   - 예: 5초 후 report 미수신이면 `checker::refresh_webview(..., "checker no-report retry")`.
   - 실제 테스트상 reload/trigger만으로는 부족할 수 있으므로 WebView 재생성까지
     포함해야 한다.
4. 초기 트레이 아이콘을 노란색이 아닌 기본/로딩 상태로 둔다.
   - 이건 증상 완화이며, checker 미보고 자체를 해결하지는 않는다.

## 테스트 기준

수정 후 최소 검증:

```bash
cd src-tauri
cargo clippy --locked -- -D warnings
cargo test --locked
```

수동 검증:

1. logged-in snapshot 복구 후 앱 실행.
2. 시작 10초 내 `checker.js loaded`와 `report: needs_login=false` 확인.
3. taskbar/Dock에 보이는 일반 창이 없는 상태에서도 checker report가 유지되는지 확인.
4. 출석 창 열기/닫기 후 `attendance window closed, reloading checker` 다음에
   `checker.js loaded` 또는 `report: needs_login=false`가 다시 찍히는지 확인.
5. 앱 재시작 3회 반복.

성공 조건:

- 재시작/창 닫힘 이후에도 checker report가 끊기지 않는다.
- 로그인 세션이 있는 snapshot 복구 상태에서 노란 아이콘이 지속되지 않는다.
- 앱이 taskbar/Dock에 남지 않는다.
