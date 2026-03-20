use chrono::{DateTime, FixedOffset, Timelike, Utc};
use serde::{Deserialize, Serialize};

use crate::config::Config;

/// 앱 전역 상태. scheduler, checker, tray 모듈에서 공유.
/// `Arc<Mutex<AppState>>`로 보호되며 Tauri managed state로 접근.
pub struct AppState {
    pub config: Config,
    /// 학습 시작(체크인) 완료 여부 (LMS 테이블 기준)
    pub morning_checked: bool,
    /// 학습 종료(체크아웃) 완료 여부 (LMS 테이블 기준)
    pub evening_checked: bool,
    /// 현재 일일 상태 (스케줄러가 계산)
    pub phase: DailyPhase,
    /// 로그인이 필요한 상태 (API 401 또는 로그인 페이지)
    pub needs_login: bool,
    /// 체커로부터 첫 보고를 받았는지 여부.
    /// false일 때는 상태 계산을 건너뛰어 잘못된 데이터 표시를 방지.
    pub data_loaded: bool,
    /// 마지막으로 확인한 KST 날짜 (day-of-year), 일일 리셋 감지용
    pub last_reset_day: Option<u32>,
    /// 체커 WebView 마지막 리로드 시각
    pub last_reload: Option<DateTime<Utc>>,
    /// 로그인 재시도 윈도우 마감 시각.
    /// 출석 페이지가 닫힌 후 일정 시간 동안만 로그인 상태를 재확인.
    pub login_retry_until: Option<DateTime<Utc>>,
    /// 마지막 알림 전송 시각
    pub last_notification: Option<DateTime<Utc>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            morning_checked: false,
            evening_checked: false,
            phase: DailyPhase::Idle,
            needs_login: false,
            data_loaded: false,
            last_reset_day: None,
            last_reload: None,
            login_retry_until: None,
            last_notification: None,
        }
    }
}

/// KST (UTC+9) 타임존 오프셋.
pub fn kst() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).unwrap()
}

/// 일일 출석 상태 — 하루에 한 번의 선형 흐름.
///
/// 타임라인 (KST):
/// ```text
/// 00:00       04:00       10:00              23:00       04:00
///  |-- Idle --|-- NeedStart --|-- StartOverdue --|           |
///             |     (시작 후) Studying ----------|-- NeedEnd --|
///             |                                  (둘 다 완료) Complete
/// ```
///
/// - `NeedStart`: 체크인 가능, 목표 시간 전
/// - `StartOverdue`: 목표 시간 지남, 아직 체크인 가능
/// - `Studying`: 체크인 완료, 체크아웃 시간 대기 중
/// - `NeedEnd`: 체크아웃 가능
/// - `Complete`: 체크인 + 체크아웃 모두 완료
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DailyPhase {
    /// 비활성 시간 (00:00-03:59, 미시작)
    Idle,
    /// 체크인 가능, 목표 시간 전 (04:00 ~ 10:00)
    NeedStart,
    /// 체크인 지각, 목표 시간 초과 (10:00 ~ 23:00)
    StartOverdue,
    /// 학습 중 — 체크인 완료, 체크아웃 아직 불가
    Studying,
    /// 체크아웃 가능 (23:00 ~ 04:00)
    NeedEnd,
    /// 오늘 출석 완료
    Complete,
}

/// 현재 일일 상태와 다음 전환까지 남은 초를 계산.
///
/// 카운트다운이 의미 있으면 `(phase, Some(초))`, 없으면 `(phase, None)` 반환.
pub fn compute_daily_phase(
    config: &Config,
    now: DateTime<Utc>,
    started: bool,
    ended: bool,
) -> (DailyPhase, Option<i64>) {
    if ended {
        return (DailyPhase::Complete, None);
    }

    let kst_now = now.with_timezone(&kst());
    let now_secs = (kst_now.hour() as i64) * 3600 + (kst_now.minute() as i64) * 60 + (kst_now.second() as i64);

    // 스케줄 경계 (초 단위)
    let day_start_secs = config.morning_start.to_secs();
    let end_window_secs = config.evening_start.to_secs();
    let day_end_secs = config.evening_end.to_secs();

    // 시간대 판별 (두 구간이 24시간을 커버)
    let in_start_window = now_secs >= day_start_secs && now_secs < end_window_secs; // 04:00-22:59
    let in_end_window = now_secs >= end_window_secs || now_secs < day_end_secs; // 23:00-03:59

    if !started {
        if in_start_window {
            // 체크인 가능 (04:00-22:59)
            let goal_secs = config.morning_end.to_secs();
            let remaining_to_goal = goal_secs - now_secs;

            if remaining_to_goal <= 0 {
                // 10분 유예 구간 (morning_end ~ morning_end+10분)
                let grace_remaining = goal_secs + 600 - now_secs;
                let rem = if grace_remaining > 0 { Some(grace_remaining) } else { None };
                return (DailyPhase::StartOverdue, rem);
            }

            return (DailyPhase::NeedStart, Some(remaining_to_goal));
        }

        if in_end_window {
            // 23:00-03:59 미체크인 — 시작 시간 놓침 (리셋은 04:00에 수행)
            return (DailyPhase::StartOverdue, None);
        }

        return (DailyPhase::Idle, None);
    }

    // 체크인 완료, 체크아웃 미완료
    if in_start_window {
        // 학습 중 — 체크아웃 버튼 비활성 상태
        let remaining = end_window_secs - now_secs;
        return (DailyPhase::Studying, Some(remaining));
    }

    if in_end_window {
        // 체크아웃 가능 (23:00-03:59)
        let remaining = if now_secs >= day_end_secs {
            // 자정 전 (23:xx): 마감은 다음 날 04:00
            (24 * 3600 - now_secs) + day_end_secs
        } else {
            // 자정 후 (00:xx-03:xx): 마감은 당일 04:00
            day_end_secs - now_secs
        };

        return (DailyPhase::NeedEnd, Some(remaining));
    }

    // 도달 불가 — start_window + end_window가 24시간을 커버
    (DailyPhase::Idle, None)
}
