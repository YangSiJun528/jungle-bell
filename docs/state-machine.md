# 상태 머신 (DailyPhase)

## 6가지 페이즈

```
DailyPhase {
    Idle,           // 비활성 시간 (00:00 ~ 04:00 KST)
    NeedStart,      // 학습 시작 가능 (04:00 ~ 10:00, 아직 안 함)
    StartOverdue,   // 학습 시작 기한 초과 (10:00 이후, 아직 안 함)
    Studying,       // 학습 중 (시작 완료, 종료 창 전)
    NeedEnd,        // 학습 종료 가능 (23:00 ~ 04:00 다음날)
    Complete,       // 오늘 출석 완료
}
```

---

## 상태 전이 다이어그램

```
                       [매일 04:00 리셋]
                              │
                              ▼
              ┌───────────────────────────────┐
              │           Idle                │
              │       (00:00 ~ 04:00)         │
              └───────────────┬───────────────┘
                              │ 04:00 도달
                              ▼
              ┌───────────────────────────────┐
              │         NeedStart             │  ← 빨간 아이콘
              │       (04:00 ~ 10:00)         │
              └───────────┬───────────────────┘
            morning_done  │         │ 10:00 도달
                  = true  │         ▼
                          │  ┌─────────────────┐
                          │  │  StartOverdue   │  ← 빨간 아이콘
                          │  │  (10:00 이후)   │
                          │  └──────┬──────────┘
                          │  morning_done = true
                          │         │
                          ▼         ▼
              ┌───────────────────────────────┐
              │          Studying             │  ← 흰색 아이콘
              │      (시작 완료, 23:00 전)     │
              └───────────────┬───────────────┘
                              │ 23:00 도달
                              ▼
              ┌───────────────────────────────┐
              │          NeedEnd              │  ← 빨간 아이콘
              │      (23:00 ~ 04:00)          │
              └───────────────┬───────────────┘
                   evening_done = true
                              │
                              ▼
              ┌───────────────────────────────┐
              │          Complete             │  ← 흰색 아이콘
              │       (오늘 출석 완료)          │
              └───────────────────────────────┘
```

---

## `compute_daily_phase()` 로직

`state.rs`의 핵심 함수. 입력은 UTC 시각과 두 개의 boolean.

```
입력:
  now_utc          DateTime<Utc>
  morning_checked  bool
  evening_checked  bool

처리:
  1. UTC → KST 변환 (UTC+9)
  2. 현재 시각이 어느 구간에 속하는지 판단
  3. morning_checked / evening_checked 여부 조합

출력:
  (DailyPhase, Option<remaining_seconds>)
```

### 구간 판단 규칙

| KST 시각 | morning_checked | evening_checked | 결과 |
|----------|-----------------|-----------------|------|
| 00:00 ~ 04:00 | - | - | Idle |
| 04:00 ~ 10:00 | false | - | NeedStart (남은 시간: 10:00까지) |
| 04:00 ~ 10:00 | true | false | Studying (남은 시간: 23:00까지) |
| 10:00 ~ 23:00 | false | - | StartOverdue |
| 10:00 ~ 23:00 | true | false | Studying (남은 시간: 23:00까지) |
| 10:00 ~ 23:00 | true | true | Complete |
| 23:00 ~ 24:00 | true | false | NeedEnd (남은 시간: 04:00까지) |
| 00:00 ~ 04:00 | true | false | NeedEnd (자정 이후, 04:00까지) |
| 23:00 ~ 04:00 | true | true | Complete |

> `NeedEnd` 창은 자정을 넘기므로 날짜 경계 처리가 필요하다 (Chrono로 처리).

---

## 일일 리셋

`scheduler.rs`의 매 tick에서 확인:

```
if current_day != last_reset_day && current_hour_kst >= 4 {
    morning_checked = false
    evening_checked = false
    last_reset_day = current_day
}
```

---

## 카운트다운 표시 예시

`remaining_seconds`를 받아 트레이 툴팁에 포맷:

| `remaining_seconds` | 표시 |
|---------------------|------|
| 2700 (45분) | 학습 시작 가능 (45분 남음) |
| 19800 (5.5시간) | 학습 중 (종료 가능까지 5h 30m) |
| 8100 (2시간 15분) | 학습 종료 가능 (2h 15m 남음) |
| None | (카운트다운 없음) |
