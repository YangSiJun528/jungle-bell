# checker 로그인 없음 상태 반복 재현 방법

문서 유형: how-to guide.

이 문서는 Jungle Bell의 hidden checker WebView를 로그인 없음 상태와 세션 복구
상태로 반복 전환해 재현/검증하기 위한 절차다.

목표는 사용자가 매번 수동으로 로그인/로그아웃하지 않아도 되도록 macOS WebKit
세션 저장소를 스냅샷으로 보관하고, 파일 이동/복구만으로 같은 상태를 반복해서
만드는 것이다. 세션 파일에는 인증 쿠키/토큰이 포함될 수 있으므로 절대 커밋하거나
채팅/이슈에 내용을 붙여 넣지 않는다.

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

로그인된 상태의 snapshot이 없으면 사용자가 한 번만 앱에서 로그인된 상태를 만든 뒤
이 절차를 수행한다. 그 이후 반복 재현은 snapshot 복구로 수행한다.

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

생성된 archive는 인증 세션을 포함할 수 있다. 외부 공유 금지.

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

네 항목이 모두 존재하면 archive 구조 검증은 통과다.

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

logged-in snapshot을 한 번 만든 뒤에는 다음 순서로 반복한다.

1. 앱 종료.
2. 현재 세션 디렉터리를 rollback 위치로 이동해 로그인 없음 상태를 만든다.
3. 앱 실행.
4. 기대 결과:
   - checker가 로그인 필요를 보고한다.
   - report가 없으면 watchdog refresh 또는 오프라인 상태가 기록된다.
5. 앱 종료.
6. snapshot 복구.
7. 앱 실행.
8. 기대 결과:
   - `checker.js loaded`
   - `report: needs_login=false`
   - 트레이 아이콘이 실제 상태로 변경된다.
9. 앱 종료 후 2번부터 다시 반복한다.

logged-in snapshot이 없으면 먼저 위 스냅샷 생성 절차를 수행한다.

## 로그인 없음 상태 만들기

세션 없음 테스트를 시작하기 전에 live session 후보를 rollback 디렉터리로 이동한다.

```bash
rollback_root="/private/tmp/jungle-bell-session-no-session-rollback-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$rollback_root/Library/WebKit" "$rollback_root/Library/HTTPStorages" "$rollback_root/Library/Caches"

mv "$HOME/Library/WebKit/jungle-bell" "$rollback_root/Library/WebKit/" 2>/dev/null || true
mv "$HOME/Library/WebKit/dev.sijun-yang.jungle-bell" "$rollback_root/Library/WebKit/" 2>/dev/null || true
mv "$HOME/Library/HTTPStorages/jungle-bell.binarycookies" "$rollback_root/Library/HTTPStorages/" 2>/dev/null || true
mv "$HOME/Library/HTTPStorages/dev.sijun-yang.jungle-bell.binarycookies" "$rollback_root/Library/HTTPStorages/" 2>/dev/null || true
mv "$HOME/Library/Caches/jungle-bell" "$rollback_root/Library/Caches/" 2>/dev/null || true
mv "$HOME/Library/Caches/dev.sijun-yang.jungle-bell" "$rollback_root/Library/Caches/" 2>/dev/null || true
```

이 작업은 파일을 삭제하지 않고 rollback 위치로 이동한다. 필요하면 rollback
디렉터리에서 원래 위치로 되돌릴 수 있다.

## 앱 실행과 관찰

```bash
cd src-tauri
RUST_LOG=info cargo tauri dev
```

로그인 없음 상태에서 확인할 신호:

```text
app starting
checker page loaded
checker.js loaded
checker.js ready
report: needs_login=true
```

세션 복구 상태에서 확인할 신호:

```text
app starting
checker page loaded
checker.js loaded
checker.js ready
report: needs_login=false
```

no-report 장애를 확인할 때 볼 신호:

```text
checker page loaded
trigger_check emitted
watchdog
checker webview reloaded 또는 checker webview navigated
```

원본 로그를 기록할 때는 쿠키, WebKit storage, API raw response body, 사용자 ID,
cohort ID, attendance ID 같은 내부 식별자를 포함하지 않는다.

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
4. 출석 창 열기/닫기 후 checker가 다시 로드되거나 report를 보내는지 확인.
5. 앱 재시작 3회 반복.

성공 조건:

- 재시작/창 닫힘 이후에도 checker report가 끊기지 않는다.
- 로그인 세션이 있는 snapshot 복구 상태에서 로그인 경고/오프라인 상태가 부정확하게 지속되지 않는다.
- 앱이 taskbar/Dock에 남지 않는다.
