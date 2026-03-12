//! 스케줄러 모듈 — 앱의 주기적 로직을 구동하는 백그라운드 루프.
//!
//! tokio 태스크로 실행되며, 적응형 간격으로 틱:
//!   - 2초: 첫 체커 보고 대기 중
//!   - 10초: 사용자 액션 필요 시 (NeedStart, StartOverdue, NeedEnd)
//!   - 120초: 대기 중 (Studying, Complete, Idle)
//!
//! 매 틱마다: 날짜 변경 시 일일 리셋, 상태 계산, 트레이 갱신,
//! 체커 WebView 주기적 리로드를 수행.

use std::sync::Arc;

use chrono::{Datelike, Timelike, Utc};
use log::{debug, info};
use tokio::sync::Mutex;

use tauri::Manager;

use crate::checker;
use crate::state::{self, kst, AppState, DailyPhase};
use crate::tray;

/// 액션 필요 시 틱 간격 (초)
const TICK_INTERVAL_ACTIVE: u64 = 10;
/// 대기 시 틱 간격 (초)
const TICK_INTERVAL_IDLE: u64 = 120;

/// 체커 WebView 리로드 간격 (틱 단위, 초가 아님).
/// 일반: 15틱 * 120초 = ~30분. 로그인 필요: 3틱 * 10초 = ~30초.
const RELOAD_TICKS_NORMAL: u32 = 15;
const RELOAD_TICKS_LOGIN: u32 = 3;

/// 백그라운드 스케줄러 루프 시작.
pub fn start_scheduler(app_handle: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        {
            let s = shared_state.lock().await;
            info!(
                "config: day_start={:02}:{:02} start_deadline={:02}:{:02} end_open={:02}:{:02} day_end={:02}:{:02}",
                s.config.morning_start.hour,
                s.config.morning_start.minute,
                s.config.morning_end.hour,
                s.config.morning_end.minute,
                s.config.evening_start.hour,
                s.config.evening_start.minute,
                s.config.evening_end.hour,
                s.config.evening_end.minute,
            );
        }
        loop {
            let tick_secs = {
                let now = Utc::now();
                let kst_now = now.with_timezone(&kst());
                let mut s = shared_state.lock().await;

                // --- 일일 리셋 ---
                // KST 날짜가 바뀌고 morning_start 이후이면
                // 어제의 체크인/체크아웃 상태를 초기화.
                let current_day = kst_now.ordinal();
                let current_hour = kst_now.hour();

                if let Some(last_day) = s.last_reset_day {
                    if current_day != last_day && current_hour >= s.config.morning_start.hour {
                        info!("daily reset at KST={}", kst_now.format("%Y-%m-%d %H:%M:%S"));
                        s.morning_checked = false;
                        s.evening_checked = false;
                        s.last_reset_day = Some(current_day);
                    }
                } else {
                    s.last_reset_day = Some(current_day);
                }

                // --- 상태 계산 ---
                // 체커의 첫 보고가 올 때까지 건너뜀.
                let mut remaining: Option<i64> = None;
                if s.data_loaded {
                    let (phase, rem) = state::compute_daily_phase(&s.config, now, s.morning_checked, s.evening_checked);
                    remaining = rem;

                    let phase_changed = phase != s.phase;

                    if phase_changed {
                        info!(
                            "phase={:?} started={} ended={} remaining={:?} needs_login={}",
                            phase, s.morning_checked, s.evening_checked, remaining, s.needs_login,
                        );
                    }

                    s.phase = phase;

                    tray::update_tray(&app_handle, phase, remaining, s.needs_login);

                    // 프론트엔드 창이 상태 변화에 반응할 수 있도록 이벤트 발행
                    if phase_changed {
                        let _ = tauri::Emitter::emit(&app_handle, "phase-changed", &phase);
                    }
                }

                // --- 체커 WebView 주기적 리로드 ---
                // 체커 WebView가 오래되면 세션 만료나 SPA 상태 드리프트 발생 가능.
                // 주기적으로 출석 페이지로 다시 이동시킴.
                s.tick_count += 1;
                let reload_threshold = if s.needs_login {
                    RELOAD_TICKS_LOGIN
                } else {
                    RELOAD_TICKS_NORMAL
                };
                if s.tick_count >= reload_threshold {
                    s.tick_count = 0;
                    if let Some(checker) = app_handle.get_webview_window("checker") {
                        debug!("reloading checker webview");
                        let _ = checker.navigate("https://jungle-lms.krafton.com/check-in".parse().unwrap());
                    }
                }

                // --- 적응형 틱 간격 ---
                // 액션 필요 시 빠르게, 대기 시 느리게.
                // 상태 전환 시점이 임박하면 그 시점에 맞춰 깨어남.
                let base_interval = if !s.data_loaded {
                    2 // 첫 체커 보고까지 빠르게 폴링
                } else {
                    match s.phase {
                        DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd => TICK_INTERVAL_ACTIVE,
                        _ => TICK_INTERVAL_IDLE,
                    }
                };
                if let Some(secs) = remaining {
                    let secs = secs as u64;
                    if secs > 0 && secs < base_interval {
                        secs + 1 // 전환 직후에 깨어나기
                    } else {
                        base_interval
                    }
                } else {
                    base_interval
                }
            };

            // Rust가 오케스트레이터: 매 틱마다 JS 스냅샷 수집을 트리거.
            // 결과는 report_attendance_status 커맨드를 통해 비동기로 돌아온다.
            checker::trigger_check(&app_handle);

            tokio::time::sleep(tokio::time::Duration::from_secs(tick_secs)).await;
        }
    });
}
