# 아키텍처

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 앱 프레임워크 | [Tauri v2](https://tauri.app/) (Rust + WebView) |
| 백엔드 | Rust (async/await, Tokio 런타임) |
| 프론트엔드 | 바닐라 HTML/CSS/JS (빌드 과정 없음, npm 없음) |
| 비동기 | Tokio v1 (`time`, `sync` 피처) |
| 시간 처리 | Chrono v0.4 (KST = UTC+9 고정 오프셋) |
| 직렬화 | Serde v1 (JSON) |
| 설정 경로 | Dirs v6 (플랫폼별 설정 디렉토리) |

---

## 프로젝트 구조

```
jungle-bell/
├── src-tauri/               # Rust 백엔드
│   ├── src/
│   │   ├── lib.rs           # 앱 진입점, Tauri 초기화
│   │   ├── main.rs          # 바이너리 래퍼 (lib.rs 위임)
│   │   ├── state.rs         # 전역 상태 + 페이즈 계산
│   │   ├── checker.rs       # JS 스냅샷 수신 + 상태 업데이트
│   │   ├── scheduler.rs     # 백그라운드 루프 (Tokio task)
│   │   ├── tray.rs          # 시스템 트레이 UI
│   │   └── config.rs        # 스케줄 설정 (하드코딩)
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                     # 프론트엔드
│   ├── checker.js           # DOM 수집 스크립트 (WebView에 주입)
│   ├── index.html           # 설정 UI
│   └── styles.css
│
└── docs/                    # 문서
```

---

## WebView 구조

Tauri 앱은 **3개의 WebView**를 관리한다:

```
┌─────────────────────────────────┐
│  Checker WebView (숨김)          │  ← LMS 출석 페이지 로드
│  - checker.js 주입               │  ← DOM 파싱, 상태 보고
│  - 사용자에게 보이지 않음           │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Attendance WebView (가시)       │  ← 사용자가 "출석 페이지 열기"
│  - 실제 LMS 페이지                │     클릭 시 생성
│  - 660 × 700 px                 │  ← 닫히면 Checker 리로드
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Settings WebView (가시)         │  ← "설정" 클릭 시 생성
│  - index.html (400 × 420 px)    │
└─────────────────────────────────┘
```

---

## 모듈 책임

### `state.rs` - 상태 머신

전역 상태 `AppState`를 정의하고, 현재 시간 + 체크인 여부로 `DailyPhase`를 계산한다.

```rust
pub struct AppState {
    pub morning_checked: bool,    // 학습 시작 완료
    pub evening_checked: bool,    // 학습 종료 완료
    pub needs_login: bool,        // 로그인 페이지 여부
    pub data_loaded: bool,        // 첫 스냅샷 수신 여부
    pub last_reset_day: u32,      // 마지막 리셋 날짜
}
```

`compute_daily_phase(now_utc, morning_checked, evening_checked)` → `(DailyPhase, Option<남은 초>)`

---

### `checker.rs` - LMS 모니터링

JavaScript가 DOM을 파싱하여 아래 구조체를 Tauri command로 전송한다:

```rust
pub struct AttendanceReport {
    pub needs_login: bool,           // 로그인 페이지?
    pub button_text: Option<String>, // "학습 시작" / "학습 종료"
    pub is_disabled: bool,           // 버튼 비활성화?
    pub morning_done: bool,          // 테이블에 시작 시간 기록됨?
    pub evening_done: bool,          // 테이블에 종료 시간 기록됨?
    pub page_url: Option<String>,
    pub page_not_ready: bool,        // 페이지 로딩 중?
}
```

`report_attendance_status` (Tauri command) → AppState 업데이트 → 트레이 갱신

---

### `scheduler.rs` - 백그라운드 루프

Tokio async task로 실행. **적응형 폴링 간격** 사용:

| 상황 | 간격 |
|------|------|
| 첫 스냅샷 대기 | 2초 |
| 행동 필요 (NeedStart, NeedEnd 등) | 10초 |
| 대기 상태 (Idle, Studying, Complete) | 120초 |
| 상태 전환 직전 | 전환 시각에 맞춰 조기 기상 |

매 tick마다:
1. 04:00 KST 일일 리셋 확인
2. `DailyPhase` 계산
3. 트레이 아이콘/툴팁 갱신
4. 페이즈 변경 시 `phase-changed` 이벤트 발행
5. 주기적 WebView 리로드 (정상: 30분, 로그인 필요: 30초)

---

### `tray.rs` - 시스템 트레이 UI

**아이콘 선택 로직:**

```
needs_login == true    →  주황 아이콘
NeedStart / StartOverdue / NeedEnd  →  빨강 아이콘
그 외 (Idle, Studying, Complete)    →  흰색 아이콘
```

**트레이 메뉴:**

```
현재 상태 (비활성, 카운트다운 표시)
─────────────────────
출석 페이지 열기
설정
─────────────────────
종료
```

---

### `lib.rs` - 앱 초기화 순서

1. 로거 초기화 (`RUST_LOG` 환경변수 참조)
2. 설정 로드 (`config.rs`)
3. `Arc<Mutex<AppState>>` 생성
4. Tauri 앱 빌드:
   - 트레이 아이콘 등록
   - Checker WebView 생성 (숨김, `checker.js` 주입)
   - 백그라운드 스케줄러 spawn
   - Tauri command 핸들러 등록
5. 윈도우 닫기 방지 (Checker WebView 숨김 유지)

---

## 동시성 모델

- **공유 상태:** `Arc<Mutex<AppState>>` (스레드 안전)
- **데드락 방지:** 뮤텍스 획득 실패 시 `try_lock` + 로그 (크래시 없음)
- **네트워크 없음:** WebView가 직접 LMS 페이지를 렌더링 (API 호출 없음)
- **DB 없음:** 모든 상태 인메모리, 매일 리셋
