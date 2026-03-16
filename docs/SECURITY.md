# 보안 구조 (Security Architecture)

Jungle Bell은 Tauri v2의 capability 기반 권한 모델을 사용한다.
WebView에서 접근 가능한 기능은 `src-tauri/capabilities/*.json`에 선언된 것만 허용되며, 선언되지 않은 Tauri 커맨드나 플러그인 API는 호출 자체가 차단된다.

## Capability 파일 요약

### `default.json`

적용 대상: `settings`, `checker`, `attendance` (전체 WebView)

| 권한 | 설명 |
|---|---|
| `core:default` | IPC 이벤트 emit/listen 등 기본 통신 |
| `opener:default` | URL/파일을 OS 기본 앱으로 열기 |
| `updater:default` | 앱 업데이트 확인 및 설치 |
| `notification:default` | OS 네이티브 알림 발송 |
| `dialog:default` | 메시지/확인 다이얼로그 표시 |

### `checker.json`

적용 대상: `checker` WebView만

| 권한 | 설명 |
|---|---|
| `core:default` | IPC 기본 통신 |
| `remote.urls` | `https://jungle-lms.krafton.com/*` 접근만 허용 |
| `local: false` | 로컬 파일/리소스 접근 차단 |

## 사용 중인 Tauri 플러그인과 역할

| 플러그인 | 용도 | capability에서 허용 여부 |
|---|---|---|
| `tauri-plugin-log` | Rust 쪽 파일 로깅 (WebView에서 직접 접근 불가, IPC `log_from_js` 경유) | 별도 권한 불필요 (Rust 내부) |
| `tauri-plugin-dialog` | 메시지/확인 다이얼로그 | `dialog:default` 허용 |
| `tauri-plugin-notification` | OS 알림 발송 | `notification:default` 허용 |
| `tauri-plugin-opener` | URL/파일을 OS 기본 앱으로 열기 | `opener:default` 허용 |
| `tauri-plugin-updater` | GitHub Releases 기반 자동 업데이트 | `updater:default` 허용 |
| `tauri-plugin-autostart` | OS 로그인 시 자동 시작 등록/해제 | capability 불필요 (Rust setup에서 직접 호출) |
| `tauri-plugin-single-instance` | 앱 중복 실행 방지 | capability 불필요 (Rust setup에서 직접 호출) |

## 허용되지 않은 권한 (명시적으로 없음)

아래 권한은 capability에 선언되어 있지 않으므로 WebView에서 호출할 수 없다:

- `fs` — 파일 시스템 읽기/쓰기
- `shell` — 외부 프로세스 실행
- `process` — 프로세스 종료/관리
- `http` — Rust 쪽 HTTP 클라이언트 (WebView의 fetch와 별개)
- `clipboard` — 클립보드 접근
- `global-shortcut` — 전역 키보드 단축키

## 데이터 흐름과 경계

```
[checker WebView]                    [Rust 프로세스]
  checker.js                           checker.rs
    │                                     │
    ├─ fetch() ─→ jungle-lms.krafton.com  │  (WebView 자체 네트워크, remote.urls로 제한)
    │                                     │
    ├─ invoke("report_attendance_status") ─→ 상태 업데이트 (AppState)
    ├─ invoke("log_from_js") ────────────→ log crate → tauri-plugin-log → 파일
    │                                     │
    ×  파일 시스템 직접 접근 불가          ├─ 로그 파일 쓰기 (app_log_dir)
    ×  외부 프로세스 실행 불가            ├─ 설정 파일 읽기/쓰기 (config.rs)
    ×  다른 도메인 접근 불가              └─ 트레이 아이콘 업데이트
```

- 파일 I/O(로그, 설정)는 전부 Rust 프로세스에서 처리
- WebView → Rust 방향은 `invoke()`로만 통신하며, capability에 없는 커맨드는 차단
- 외부에서 앱 내부 IPC를 호출할 수 있는 경로는 없음

## 플러그인 권한 공개 정보

각 Tauri 플러그인의 세부 권한(default에 포함된 것, 추가로 열 수 있는 것)은 공식 문서에서 확인할 수 있다:

- 전체 플러그인 목록: https://tauri.app/plugin/
- 각 플러그인 페이지 하단 **Permissions** 섹션에서 `default`에 포함된 권한과 개별 권한 목록 확인 가능
- 예: `opener:default`는 URL 열기만 허용하고 파일 실행(`opener:allow-execute`)은 기본 비활성

## 보안 판단 근거

1. **capability JSON이 검증 포인트**: WebView가 접근할 수 있는 기능은 capability 파일에 명시된 것이 전부. 이 파일을 보면 앱의 권한 범위를 완전히 파악할 수 있다.

2. **앱 코드의 책임**: capability로 허용된 범위 안에서도 안전하지 않은 코드를 작성할 수는 있다(예: IPC 핸들러에서 사용자 입력을 검증 없이 사용). 현재 코드에서는 IPC 핸들러가 단순 상태 업데이트와 설정 변경만 수행하므로 공격 표면이 작다.

3. **Tauri 프레임워크의 신뢰성**: Tauri는 CrabNebula가 후원하고, OWASP 기반 보안 모델을 적용하며, 보안 감사(audit)를 거친 오픈소스 프로젝트다. 엔터프라이즈 프로덕션 수준의 완전성을 보장하지는 않지만, 데스크톱 앱 프레임워크 중 보안 설계가 잘 되어 있는 편이다.
