# 데이터 흐름

## 전체 흐름 개요

```
[Scheduler tick]
      │
      │ emit "trigger-check"
      ▼
[Checker WebView (숨김)]
      │
      │ checker.js 실행
      │ - DOM 파싱 (출석 테이블, 버튼)
      │ - AttendanceReport JSON 생성
      │
      │ invoke("report_attendance_status", report)
      ▼
[Rust: checker.rs]
      │
      │ AppState 업데이트
      │ - morning_checked / evening_checked
      │ - needs_login
      │
      │ compute_daily_phase()
      │
      │ update_tray()
      ▼
[트레이 아이콘/툴팁 갱신]
```

---

## checker.js - DOM 파싱 로직

JavaScript가 출석 페이지에서 읽는 정보:

```
1. URL 확인 → 로그인 페이지 여부 판단

2. 출석 테이블:
   rows[0].cells[2]  →  학습 시작 시간 (기록 있으면 morning_done = true)
   rows[0].cells[3]  →  학습 종료 시간 (기록 있으면 evening_done = true)

3. 액션 버튼:
   [data-variant="destructive"]
   textContent  →  "학습 시작" 또는 "학습 종료"
   disabled     →  is_disabled

4. 페이지 로딩 상태:
   테이블/버튼 없으면 page_not_ready = true
```

---

## 상태 업데이트 흐름

```
report_attendance_status(report) 수신 시:

if report.page_not_ready → skip (무시)

if report.needs_login:
    state.needs_login = true

else:
    state.needs_login = false
    if report.morning_done: state.morning_checked = true
    if report.evening_done: state.evening_checked = true

state.data_loaded = true

→ compute_daily_phase() 호출
→ update_tray() 호출
```

---

## 사용자가 체크인하는 흐름

```
1. 트레이 아이콘이 빨간색으로 바뀜

2. 사용자가 트레이 메뉴 → "출석 페이지 열기" 클릭

3. Attendance WebView 창 열림 (실제 LMS 페이지)

4. 사용자가 "학습 시작" 또는 "학습 종료" 버튼 클릭

5. 사용자가 창 닫음
   → on_window_event(Destroyed) 감지
   → Checker WebView 리로드

6. 다음 Scheduler tick에서 trigger-check 실행

7. JS가 테이블에서 시간 기록 확인
   → morning_done = true 또는 evening_done = true

8. AppState 업데이트
   → morning_checked = true 또는 evening_checked = true

9. DailyPhase 재계산
   → Studying 또는 Complete

10. 트레이 아이콘이 흰색으로 바뀜
```

---

## WebView 리로드 타이밍

`scheduler.rs`에서 tick 카운터로 관리:

```
정상 상태:
  reload_counter += 1
  if reload_counter >= 15:   // 15 × 120s = 30분
      WebView 리로드
      reload_counter = 0

로그인 필요:
  reload_counter += 1
  if reload_counter >= 3:    // 3 × 10s = 30초
      WebView 리로드
      reload_counter = 0
```

---

## 이벤트 목록

| 이벤트 이름 | 방향 | 설명 |
|-------------|------|------|
| `trigger-check` | Rust → WebView | JS에게 DOM 수집 요청 |
| `report_attendance_status` | WebView → Rust | JS가 AttendanceReport 전송 |
| `phase-changed` | Rust 내부 | 페이즈 전환 시 발행 (로깅용) |
