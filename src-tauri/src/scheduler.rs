//! 스케줄러 모듈 — 앱의 주기적 로직을 구동하는 백그라운드 루프.
//!
//! tokio 태스크로 실행되며, 적응형 간격으로 틱:
//!   - 5초: 첫 체커 보고 대기 중
//!   - 60초: 사용자 액션 필요 시 (NeedStart, StartOverdue, NeedEnd)
//!   - 300초: 대기 중 (Studying, Complete, Idle)
//!
//! 매 틱마다: 날짜 변경 시 일일 리셋, 상태 계산, 트레이 갱신,
//! 체커 WebView 주기적 리로드를 수행.
//! API 기반 조회를 사용하므로 DOM 의존성 없이 안정적으로 동작.

use std::sync::Arc;

use chrono::{Datelike, Timelike, Utc};
use log::{debug, info};
use tokio::sync::Mutex;
use tokio::time::Instant;

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::checker;
use crate::state::{self, kst, AppState, DailyPhase};
use crate::tray;

/// 액션 필요 시 틱 간격 (초). API 호출 빈도를 줄이기 위해 60초.
const TICK_INTERVAL_ACTIVE: u64 = 60;
/// 대기 시 틱 간격 (초). 5분 간격으로 상태 확인.
const TICK_INTERVAL_IDLE: u64 = 300;

/// 체커 WebView 리로드 간격 (초). 세션/토큰 갱신 목적.
const RELOAD_INTERVAL_NORMAL: u64 = 15 * 60; // 15분

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

                    // --- 네이티브 알림 ---
                    if s.config.notification_enabled && !s.needs_login {
                        let should_notify = matches!(
                            s.phase,
                            DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd
                        );
                        let kst_mins = (kst_now.hour() * 60 + kst_now.minute()) as i32;
                        let notif_start_mins = (s.config.notification_start.hour * 60
                            + s.config.notification_start.minute) as i32;
                        let notif_end_mins = (s.config.notification_end.hour * 60
                            + s.config.notification_end.minute) as i32;
                        let evening_start_mins = (s.config.evening_start.hour * 60
                            + s.config.evening_start.minute) as i32;

                        let in_notification_window = match s.phase {
                            DailyPhase::NeedStart | DailyPhase::StartOverdue => {
                                // 아침: notification_start 이후만
                                kst_mins >= notif_start_mins
                            }
                            DailyPhase::NeedEnd => {
                                // 저녁: evening_start ~ notification_end (자정 넘김 처리)
                                if notif_end_mins <= evening_start_mins {
                                    // 예: 23:00~01:00 → 자정 넘김
                                    kst_mins >= evening_start_mins || kst_mins < notif_end_mins
                                } else {
                                    kst_mins >= evening_start_mins && kst_mins < notif_end_mins
                                }
                            }
                            _ => false,
                        };

                        if should_notify && in_notification_window {
                            let interval_secs =
                                s.config.notification_interval_mins as u64 * 60;
                            let should_send = match s.last_notification {
                                Some(last) => last.elapsed()
                                    >= std::time::Duration::from_secs(interval_secs),
                                None => true,
                            };
                            if should_send {
                                let (title, body) =
                                    notification_message(s.phase, remaining);
                                let _ = app_handle
                                    .notification()
                                    .builder()
                                    .title(title)
                                    .body(body)
                                    .show();
                                s.last_notification = Some(Instant::now());
                                info!("notification sent: phase={:?}", s.phase);
                            }
                        }
                    }

                    // 프론트엔드 창이 상태 변화에 반응할 수 있도록 이벤트 발행
                    if phase_changed {
                        let _ = tauri::Emitter::emit(&app_handle, "phase-changed", &phase);
                    }
                }

                // --- 체커 WebView 주기적 리로드 ---
                // API 호출은 WebView 쿠키를 사용하므로 세션/토큰 갱신을 위해
                // 주기적으로 출석 페이지로 다시 이동시킴 (15분 간격).
                // 로그인 필요 시에는 리로드하지 않음 (출석 페이지 닫힘 시에만 리로드).
                if !s.needs_login {
                    let now = Instant::now();
                    let should_reload = match s.last_reload {
                        Some(last) => now.duration_since(last) >= std::time::Duration::from_secs(RELOAD_INTERVAL_NORMAL),
                        None => {
                            s.last_reload = Some(now);
                            false
                        }
                    };
                    if should_reload {
                        s.last_reload = Some(now);
                        if let Some(checker) = app_handle.get_webview_window("checker") {
                            debug!("reloading checker webview");
                            let _ = checker.navigate("https://jungle-lms.krafton.com/check-in".parse().unwrap());
                        }
                    }
                }

                // --- 로그인 재시도 윈도우 만료 확인 ---
                if let Some(until) = s.login_retry_until {
                    if Instant::now() >= until {
                        s.login_retry_until = None;
                        debug!("login retry window expired");
                    }
                }

                // --- 적응형 틱 간격 ---
                // 로그인 필요 시: 출석 페이지 열림 또는 재시도 윈도우 활성이면 빠르게 폴링,
                // 그 외에는 불필요한 요청을 보내지 않음.
                // 액션 필요 시 60초, 대기 시 300초.
                let attendance_open = app_handle.get_webview_window("attendance").is_some();
                let base_interval = if !s.data_loaded {
                    5 // 첫 체커 보고까지 빠르게 폴링
                } else if s.needs_login {
                    if attendance_open || s.login_retry_until.is_some() {
                        10 // 출석 페이지 열림 또는 재시도 윈도우 활성: 빠르게 확인
                    } else {
                        600 // 로그인 필요하지만 재시도 없음: 대기
                    }
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

/// phase와 남은 시간으로 알림 제목·본문 생성.
fn notification_message(phase: DailyPhase, remaining: Option<i64>) -> (&'static str, String) {
    match phase {
        DailyPhase::NeedStart => {
            let body = if let Some(secs) = remaining {
                let mins = secs / 60;
                if mins >= 60 {
                    format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
                } else {
                    format!("마감까지 {}분 남았습니다.", mins)
                }
            } else {
                "출석 체크를 해주세요.".into()
            };
            ("출석 체크 시간입니다", body)
        }
        DailyPhase::StartOverdue => (
            "출석 체크 지각!",
            "빨리 체크인하세요.".into(),
        ),
        DailyPhase::NeedEnd => {
            let body = if let Some(secs) = remaining {
                let mins = secs / 60;
                if mins >= 60 {
                    format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
                } else {
                    format!("마감까지 {}분 남았습니다.", mins)
                }
            } else {
                "학습 종료 체크를 해주세요.".into()
            };
            ("학습 종료 체크가 필요합니다", body)
        }
        _ => ("Jungle Bell", "출석 상태를 확인하세요.".into()),
    }
}
