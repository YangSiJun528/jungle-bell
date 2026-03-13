# 개발 가이드

## 사전 요구사항

| 도구 | 비고 |
|------|------|
| Rust (최신 stable) | `rustup` 으로 설치 |
| Xcode Command Line Tools | macOS 한정 (`xcode-select --install`) |
| Tauri CLI | `cargo install tauri-cli` |

Node.js 및 npm은 **불필요** (프론트엔드에 빌드 과정 없음).

---

## 개발 실행

```bash
# 저장소 클론
git clone https://github.com/sijun-yang/jungle-bell
cd jungle-bell

# 개발 모드 실행 (핫 리로드 포함)
cargo tauri dev

# 상세 로그와 함께 실행
RUST_LOG=debug cargo tauri dev

# 기본 로그 레벨 (info)
RUST_LOG=info cargo tauri dev
```

---

## 프로덕션 빌드

```bash
cargo tauri build

# 결과물 위치:
# macOS: src-tauri/target/release/bundle/dmg/*.dmg
#        src-tauri/target/release/bundle/macos/*.app
# Windows: src-tauri/target/release/bundle/nsis/*-setup.exe
```

---

## 코드 포맷

```bash
cd src-tauri
cargo fmt
```

`rustfmt.toml` 설정이 `src-tauri/` 에 있다.

---

## 로그 레벨

| `RUST_LOG` 값 | 출력 내용 |
|---------------|----------|
| `error` | 오류만 |
| `warn` | 경고 이상 |
| `info` | 일반 동작 로그 (기본값) |
| `debug` | 상세 로그 (HTML 덤프 포함) |

---

## 파일 수정 가이드

### 스케줄 시간 변경 (`config.rs`)

```rust
// src-tauri/src/config.rs
Config {
    morning_start: TimeOfDay { hour: 4,  minute: 0 },  // 학습 시작 창 시작
    morning_end:   TimeOfDay { hour: 10, minute: 0 },  // 학습 시작 창 종료
    evening_start: TimeOfDay { hour: 23, minute: 0 },  // 학습 종료 창 시작
    evening_end:   TimeOfDay { hour: 4,  minute: 0 },  // 학습 종료 창 종료 (다음날)
}
```

### DOM 파싱 로직 변경 (`checker.js`)

LMS 페이지 구조가 바뀌면 `src/checker.js` 수정:
- 테이블 셀 인덱스 (`cells[2]`, `cells[3]`)
- 버튼 셀렉터 (`[data-variant="destructive"]`)
- 로그인 페이지 감지 조건 (URL 또는 DOM 요소)

### 트레이 아이콘 변경 (`tray.rs`)

`src-tauri/icons/` 에 PNG 파일 추가 후 `tray.rs`의 아이콘 로딩 코드 수정.

---

## 주요 의존성

```toml
# src-tauri/Cargo.toml
tauri = { version = "2", features = ["tray-icon"] }
tauri-build = "2"
tokio = { version = "1", features = ["time", "sync"] }
chrono = { version = "0.4", features = ["serde"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
dirs = "6"
log = "0.4"
env_logger = "0.11"
tauri-plugin-opener = "2"
```

---

## Tauri 설정 요점 (`tauri.conf.json`)

```json
{
  "productName": "Jungle Bell",
  "version": "0.0.1",
  "identifier": "dev.sijun-yang.jungle-bell",
  "build": {
    "frontendDist": "../src"   // 빌드 없이 src/ 폴더 직접 사용
  },
  "app": {
    "windows": []              // 기본 윈도우 없음 (트레이 전용 앱)
  }
}
```

---

## 흔한 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| 아이콘이 나타나지 않음 | macOS 트레이 권한 | 시스템 환경설정 → 알림 허용 |
| 항상 로그인 필요로 표시 | Checker WebView 세션 없음 | "출석 페이지 열기" → 로그인 → 창 닫기 |
| 상태가 업데이트 안 됨 | JS 셀렉터 미스매치 | `RUST_LOG=debug` 로 HTML 덤프 확인 |
| 빌드 실패 (macOS) | Xcode 미설치 | `xcode-select --install` |
