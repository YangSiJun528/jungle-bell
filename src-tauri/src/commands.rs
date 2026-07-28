//! 커맨드 모듈 — 모든 Tauri invoke 핸들러.
//!
//! JS에서 `window.__TAURI__.core.invoke()`로 호출하는
//! 모든 커맨드 함수가 이 모듈에 정의된다.
//! 도메인 로직은 `checker`, `updater` 등 전용 모듈에 위임한다.

use std::process::Command;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::alert_overlay::{self, AlertOverlayService, AlertOverlaySnapshot};
use crate::analytics::{self, AttendancePeriod, CampusInteraction, Event, Setting};
use crate::attendance;
use crate::attendance_auto_refresh::{self, StartRequestAction};
use crate::attendance_day;
use crate::autostart;
use crate::campus::{CampusDataKind, CampusService};
use crate::checker;
use crate::config;
use crate::local_consumption::{LocalConsumptionService, LocalDashboardSnapshot};
use crate::news::{self, NewsFeed, NewsService};
use crate::settings_state::{SettingsService, SettingsSnapshot};
use crate::state::{self, AppState};
use crate::tray;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub data_loaded: bool,
    pub needs_login: bool,
}

impl LoginStatus {
    fn from_state(state: &AppState) -> Self {
        Self {
            data_loaded: state.data_loaded,
            needs_login: state.needs_login,
        }
    }
}

// ── 출석 보고 ────────────────────────────────────────────

/// Tauri 커맨드: API 조회 결과를 수신.
/// `trigger_check()`가 이벤트를 보내면, JS가 이 커맨드를 invoke로 호출한다.
#[tauri::command]
pub async fn report_attendance_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    status: attendance::AttendanceReport,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let now = chrono::Utc::now();
    let checker_actions = checker::record_checker_report(&mut s, status.generation, status.api_error);
    if checker_actions
        .iter()
        .any(|action| matches!(action, checker::CheckerAction::IgnoreStale { .. }))
    {
        log::warn!(
            "[checker] stale report ignored: generation={} current_generation={}",
            status.generation,
            s.checker.page_load_generation,
        );
        return Ok(());
    }
    if status.api_error {
        log::info!("[checker] API error received, skipping state update");
    } else {
        log::info!(
            "[checker] report: needs_login={} morning={} evening={} current_phase={:?}",
            status.needs_login,
            status.morning_done,
            status.evening_done,
            s.phase,
        );
    }
    log::debug!("[checker] report received for generation={}", status.generation);

    // 전이 감지를 위해 이전 상태 보존.
    // `was_loaded`가 false인 최초 보고는 "앱 재시작 후 오늘 이미 완료된 출석"일 수 있으므로
    // 이벤트 발사 대상에서 제외해야 한다 (중복 카운트 방지).
    let was_loaded = s.data_loaded;
    let prev_data_loaded = s.data_loaded;
    let prev_morning = s.morning_checked;
    let prev_evening = s.evening_checked;
    let prev_needs_login = s.needs_login;
    let reload_attendance = attendance_auto_refresh::confirm_start(
        &mut s.attendance_auto_refresh,
        status.morning_done,
        status.needs_login,
        status.api_error,
    );

    let phase_update = attendance::apply_attendance_report(&mut s, &status, now);
    let tray_snapshot = match phase_update {
        Some(update) => Some(attendance::build_tray_snapshot(&s, update.remaining)),
        None if status.api_error => Some(attendance::build_tray_snapshot(&s, None)),
        None => None,
    };
    let curr_needs_login = s.needs_login;
    let curr_data_loaded = s.data_loaded;
    let login_status = LoginStatus::from_state(&s);
    drop(s);

    if let Some(snapshot) = tray_snapshot {
        if let Err(error) = tray::update_tray(&app, &snapshot) {
            log::error!("[tray] checker report projection update failed: {error}");
        }
    }

    // 로그인 상태/초기 로드 상태 전이 시 이벤트 발사 — 온보딩 슬라이드가 ✓ 표시 갱신용으로 listen.
    if prev_needs_login != curr_needs_login || prev_data_loaded != curr_data_loaded {
        let _ = app.emit("login-status-changed", login_status);
    }

    if !was_loaded {
        let app_for_task = app.clone();
        if let Err(e) = app.run_on_main_thread(move || tray::sync_foreground_app_visibility(&app_for_task)) {
            log::warn!("[checker] foreground visibility sync scheduling failed: {}", e);
        }
    }

    // 출석 완료 이벤트: false → true 전이 시점에만 한 번 발사한다.
    // 스케줄러의 일일 리셋(자정) 이후 첫 완료 시에도 정상적으로 전이로 감지된다.
    if was_loaded && !status.api_error && !status.needs_login {
        if !prev_morning && status.morning_done {
            analytics::track(Event::AttendanceCompleted(AttendancePeriod::Morning));
        }
        if !prev_evening && status.evening_done {
            analytics::track(Event::AttendanceCompleted(AttendancePeriod::Evening));
        }
    }

    if reload_attendance {
        attendance_auto_refresh::reload_attendance_window(&app);
    }

    Ok(())
}

/// Tauri 커맨드: checker.js initialization script가 로드됐음을 수신.
#[tauri::command]
pub async fn report_checker_ready(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    generation: Option<u64>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let generation = generation.unwrap_or(s.checker.page_load_generation);
    let actions = checker::record_checker_ready(&mut s, generation);
    if actions
        .iter()
        .any(|action| matches!(action, checker::CheckerAction::IgnoreStale { .. }))
    {
        log::warn!(
            "[checker] stale checker.js ready ignored: generation={} current_generation={}",
            generation,
            s.checker.page_load_generation,
        );
        return Ok(());
    }
    log::info!("[checker] checker.js ready: generation={}", generation);
    s.notify_scheduler();
    Ok(())
}

/// Tauri 커맨드: CMS 사용자 식별자 수신. JS에서 /api/v2/me 호출 후 id를 전달.
/// SHA-256 해시하여 PostHog distinct_id로 사용.
#[tauri::command]
pub fn report_cms_identity(cms_user_id: String) {
    analytics::set_identity(&cms_user_id);
}

/// Tauri 커맨드: JS에서 Rust 로그 시스템으로 메시지 전달.
#[tauri::command]
pub fn log_from_js(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[checker:js] {}", message),
        "warn" => log::warn!("[checker:js] {}", message),
        "debug" => log::debug!("[checker:js] {}", message),
        _ => log::info!("[checker:js] {}", message),
    }
}

// ── 설정 매크로 ──────────────────────────────────────────

/// bool 설정 setter 생성 매크로.
macro_rules! setting_bool {
    ($set:ident, $field:ident, $label:expr, $setting:ident) => {
        #[tauri::command]
        pub async fn $set(
            app: tauri::AppHandle,
            settings: tauri::State<'_, Arc<SettingsService>>,
            enabled: bool,
        ) -> Result<SettingsSnapshot, String> {
            log::info!("[settings] {} 변경: {}", $label, enabled);
            let commit = settings
                .update_config(&app, stringify!($set), move |config| {
                    config.$field = enabled;
                    Ok(())
                })
                .await?;
            if commit.changed {
                analytics::track(Event::SettingChanged(Setting::$setting(enabled)));
            }
            Ok(commit.snapshot)
        }
    };
}

// ── 매크로 생성 설정 커맨드 ──────────────────────────────

setting_bool!(set_auto_update, auto_update, "자동 업데이트 설정", AutoUpdate);
setting_bool!(
    set_start_notification_enabled,
    start_notification_enabled,
    "시작 출석 알림 설정",
    StartNotificationEnabled
);
setting_bool!(
    set_end_notification_enabled,
    end_notification_enabled,
    "종료 출석 알림 설정",
    EndNotificationEnabled
);

setting_bool!(set_skip_sunday, skip_sunday, "일요일 알림 끄기", SkipSunday);

// ── 커스텀 설정 커맨드 ───────────────────────────────────

#[tauri::command]
pub async fn set_notification_delivery(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    delivery: config::NotificationDelivery,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] 알림 표시 방식 변경: {}", delivery.as_str());
    let commit = settings
        .update_config(&app, "set_notification_delivery", move |config| {
            config.notification_delivery = delivery;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::NotificationDelivery(delivery.as_str())));
    }
    Ok(commit.snapshot)
}

/// 설정 UI가 초기화/재동기화에 사용하는 단일 snapshot.
#[tauri::command]
pub async fn get_settings_snapshot(
    settings: tauri::State<'_, Arc<SettingsService>>,
) -> Result<SettingsSnapshot, String> {
    Ok(settings.snapshot().await)
}

#[tauri::command]
pub async fn resolve_cohort_selection(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    cohort_options: Vec<attendance::CohortOption>,
) -> Result<attendance::CohortResolution, String> {
    attendance::validate_cohort_options(&cohort_options)?;
    let today = chrono::Utc::now().with_timezone(&state::kst()).date_naive();
    let resolution = settings.resolve_cohort_options(&app, cohort_options, today).await;
    let snapshot = settings.snapshot().await;
    let cohort_id = attendance_cohort_id(
        snapshot.selected_cohort_id.as_deref(),
        snapshot.effective_cohort_id.as_deref(),
        &snapshot.cohort_options,
    );
    tray::sync_attendance_cohort_storage(&app, cohort_id.as_deref());
    Ok(resolution)
}

#[tauri::command]
pub async fn set_selected_cohort(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    cohort_id: Option<String>,
) -> Result<SettingsSnapshot, String> {
    if let Some(cohort_id) = cohort_id.as_deref() {
        config::validate_cohort_id(cohort_id)?;
        let snapshot = settings.snapshot().await;
        if !snapshot.cohort_options.iter().any(|option| option.id == cohort_id) {
            return Err("현재 계정에서 조회되지 않은 기수입니다.".into());
        }
    }
    let commit = settings
        .update_config(&app, "set_selected_cohort", move |config| {
            config.selected_cohort_id = cohort_id;
            Ok(())
        })
        .await?;
    if commit.changed {
        let today = chrono::Utc::now().with_timezone(&state::kst()).date_naive();
        let cohort_id =
            commit.snapshot.selected_cohort_id.clone().or_else(|| {
                attendance::resolve_cohort_selection(&commit.snapshot.cohort_options, None, today).cohort_id
            });
        tray::sync_attendance_cohort_storage(&app, cohort_id.as_deref());
        checker::trigger_current_check(&app);
    }
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_meal_subscription_enabled(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    local_consumption: tauri::State<'_, Arc<LocalConsumptionService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    let commit = settings
        .update_config(&app, "set_meal_subscription_enabled", move |config| {
            config.meal_subscription_enabled = enabled;
            Ok(())
        })
        .await?;
    local_consumption
        .on_settings_changed(&app, commit.changed && enabled)
        .await;
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_laundry_watch(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    local_consumption: tauri::State<'_, Arc<LocalConsumptionService>>,
    watch: Option<config::LaundryWatch>,
) -> Result<SettingsSnapshot, String> {
    if let Some(watch) = &watch {
        config::validate_laundry_watch(watch)?;
    }
    let commit = settings
        .update_config(&app, "set_laundry_watch", move |config| {
            config.laundry_watch = watch;
            Ok(())
        })
        .await?;
    local_consumption.on_settings_changed(&app, false).await;
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_start_notification_interval(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    value: u32,
) -> Result<SettingsSnapshot, String> {
    let value = config::validate_notification_interval(value)?;
    log::info!("[settings] 시작 출석 알림 간격 변경: {}", value);
    let commit = settings
        .update_config(&app, "set_start_notification_interval", move |config| {
            config.start_notification_interval_mins = value;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::StartNotificationIntervalMinutes(value)));
    }
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_end_notification_interval(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    value: u32,
) -> Result<SettingsSnapshot, String> {
    let value = config::validate_notification_interval(value)?;
    log::info!("[settings] 종료 출석 알림 간격 변경: {}", value);
    let commit = settings
        .update_config(&app, "set_end_notification_interval", move |config| {
            config.end_notification_interval_mins = value;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::EndNotificationIntervalMinutes(value)));
    }
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_notification_start(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    hour: u32,
    minute: u32,
) -> Result<SettingsSnapshot, String> {
    let time = config::validate_notification_start(hour, minute)?;
    log::info!("[settings] 알림 시작 시각 변경: {:02}:{:02}", time.hour, time.minute);
    let analytics_time = time.clone();
    let commit = settings
        .update_config(&app, "set_notification_start", move |config| {
            config.notification_start = time;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::NotificationStart {
            hour: analytics_time.hour,
            minute: analytics_time.minute,
        }));
    }
    Ok(commit.snapshot)
}

#[tauri::command]
pub async fn set_notification_end(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    hour: u32,
    minute: u32,
) -> Result<SettingsSnapshot, String> {
    let time = config::validate_notification_end(hour, minute)?;
    log::info!("[settings] 알림 종료 시각 변경: {:02}:{:02}", time.hour, time.minute);
    let analytics_time = time.clone();
    let commit = settings
        .update_config(&app, "set_notification_end", move |config| {
            config.notification_end = time;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::NotificationEnd {
            hour: analytics_time.hour,
            minute: analytics_time.minute,
        }));
    }
    Ok(commit.snapshot)
}

/// Tauri 커맨드: 이번 출석 알림 끄기 설정 변경 및 저장.
/// enabled=true이면 오늘 KST 날짜를 저장, false이면 None.
#[tauri::command]
pub async fn set_skip_attendance(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    let next = if enabled {
        let kst_now = chrono::Utc::now().with_timezone(&state::kst());
        Some(attendance_day::calendar_date_string(kst_now))
    } else {
        None
    };
    log::info!("[settings] 이번 출석 알림 끄기 변경: {next:?}");
    let commit = settings
        .update_config(&app, "set_skip_attendance", move |config| {
            config.skip_attendance = next;
            Ok(())
        })
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::SkipAttendance(enabled)));
    }
    Ok(commit.snapshot)
}

/// 생활정보 창이 이벤트 구독을 마쳤음을 보고한다.
#[tauri::command]
pub async fn report_campus_ready(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<CampusService>>,
) -> Result<(), String> {
    service.emit_cached_snapshots(&app).await;
    Ok(())
}

/// 생활정보 화면의 주요 사용자 상호작용을 분석 이벤트로 기록한다.
#[tauri::command]
pub fn report_campus_interaction(interaction: CampusInteraction) {
    analytics::track(Event::CampusInteraction(interaction));
}

/// 사용자가 누른 수동 새로고침을 즉시 실행한다.
#[tauri::command]
pub async fn refresh_campus_data(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<CampusService>>,
    kind: CampusDataKind,
) -> Result<(), String> {
    service.refresh(&app, kind).await
}

/// 오래된 급식 게시물 한 페이지를 불러와 생활정보 창에 전달한다.
#[tauri::command]
pub async fn load_meal_history(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<CampusService>>,
    before: Option<String>,
) -> Result<(), String> {
    service.load_meal_history(&app, before).await
}

fn validate_image_asset_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "잘못된 이미지 주소입니다.".to_string())?;
    let is_local_http = url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    let has_credentials = !url.username().is_empty() || url.password().is_some();
    if has_credentials || (url.scheme() != "https" && !is_local_http) || !url.path().starts_with("/v1/assets/") {
        return Err("허용되지 않은 이미지 주소입니다.".into());
    }
    Ok(url.to_string())
}

/// 검증된 이미지를 별도의 크기 조절 가능 창에서 연다.
#[tauri::command]
pub async fn open_image_viewer(app: tauri::AppHandle, image_url: String) -> Result<(), String> {
    let image_url = validate_image_asset_url(&image_url)?;
    tray::open_image_viewer(&app, image_url)?;
    Ok(())
}

/// Tauri 커맨드: 자동 시작 설정 변경 및 저장.
#[tauri::command]
pub async fn set_auto_start(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] 자동 시작 설정 변경: {}", enabled);
    let apply_app = app.clone();
    let rollback_app = app.clone();
    let commit = settings
        .update_config_with_effect(
            &app,
            "set_auto_start",
            move |config| {
                config.auto_start = enabled;
                Ok(())
            },
            move |_, next| autostart::sync_auto_start(&apply_app, next.auto_start),
            move |previous, _| autostart::sync_auto_start(&rollback_app, previous.auto_start),
        )
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::AutoStart(enabled)));
    }
    Ok(commit.snapshot)
}

/// Tauri 커맨드: 디버그 모드 설정 변경 및 저장.
/// 런타임에 로그 레벨도 즉시 전환 (Info ↔ Debug).
#[tauri::command]
pub async fn set_debug_mode(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] 디버그 모드 변경: {}", enabled);
    let commit = settings
        .update_config(&app, "set_debug_mode", move |config| {
            config.debug_mode = enabled;
            Ok(())
        })
        .await?;

    // 런타임 로그 레벨 즉시 전환
    let level = if enabled {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    log::set_max_level(level);
    log::info!("[settings] 로그 레벨 전환: {}", level);
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::DebugMode(enabled)));
    }
    Ok(commit.snapshot)
}

/// Tauri 커맨드: 사용 통계 전송 설정 조회.
#[tauri::command]
pub async fn get_usage_analytics_enabled(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.usage_analytics_enabled)
}

/// Tauri 커맨드: 사용 통계 전송 설정 변경 및 저장.
#[tauri::command]
pub async fn set_usage_analytics_enabled(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] 사용 통계 전송 변경: {}", enabled);
    let commit = settings
        .update_config(&app, "set_usage_analytics_enabled", move |config| {
            let previous = config.usage_analytics_enabled;
            config.usage_analytics_enabled = enabled;
            Ok(previous)
        })
        .await?;
    let previous = commit.value;

    if previous != enabled {
        if enabled {
            analytics::set_user_enabled(true);
            analytics::track(Event::UsageAnalyticsToggled(true));
            analytics::track_startup_events();
        } else {
            analytics::track(Event::UsageAnalyticsToggled(false));
            analytics::set_user_enabled(false);
        }
    } else {
        analytics::set_user_enabled(enabled);
    }
    Ok(commit.snapshot)
}

/// Tauri 커맨드: 트레이 D-Day 표시 설정 변경 및 저장.
#[tauri::command]
pub async fn set_show_dday(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] D-Day 표시 변경: {}", enabled);
    let apply_app = app.clone();
    let rollback_app = app.clone();
    let commit = settings
        .update_config_with_effect(
            &app,
            "set_show_dday",
            move |config| {
                config.show_dday = enabled;
                Ok(())
            },
            move |_, next| tray::sync_dday_panel_visibility(&apply_app, next.show_dday),
            move |previous, _| tray::sync_dday_panel_visibility(&rollback_app, previous.show_dday),
        )
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::ShowDday(enabled)));
    }
    Ok(commit.snapshot)
}

/// Tauri 커맨드: 플랫폼 앱 아이콘 표시 설정 변경 및 저장.
#[tauri::command]
pub async fn set_show_app_icon(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
    enabled: bool,
) -> Result<SettingsSnapshot, String> {
    log::info!("[settings] 앱 아이콘 표시 변경: {}", enabled);
    let apply_app = app.clone();
    let rollback_app = app.clone();
    let commit = settings
        .update_config_with_effect(
            &app,
            "set_show_app_icon",
            move |config| {
                config.show_app_icon = enabled;
                Ok(())
            },
            move |_, next| tray::set_app_icon_visibility(&apply_app, next.show_app_icon),
            move |previous, _| tray::set_app_icon_visibility(&rollback_app, previous.show_app_icon),
        )
        .await?;
    if commit.changed {
        analytics::track(Event::SettingChanged(Setting::ShowAppIcon(enabled)));
    }
    Ok(commit.snapshot)
}

// ── 업데이트 ─────────────────────────────────────────────

/// Tauri 커맨드: 업데이트 확인 후 결과를 시스템 다이얼로그로 표시.
#[tauri::command]
pub async fn check_and_notify_update(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[updater] 업데이트 확인 요청");
    tauri::async_runtime::spawn(async move {
        crate::updater::prompt_and_install_update(app, false).await;
    });
    Ok(())
}

// ── 시스템 유틸 ──────────────────────────────────────────

/// Tauri 커맨드: 로그 폴더를 시스템 파일 탐색기로 열기.
#[tauri::command]
pub async fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    log::info!("[settings] 로그 폴더 열기: {:?}", log_dir);
    tauri_plugin_opener::open_path(&log_dir, None::<&str>).map_err(|e| e.to_string())
}

/// Tauri 커맨드: 온보딩(시작하기) 창을 연다.
#[tauri::command]
pub async fn open_onboarding(app: tauri::AppHandle) {
    tray::open_onboarding_window(&app);
}

/// Tauri 커맨드: 온보딩 완료 상태를 저장한다.
#[tauri::command]
pub async fn complete_onboarding(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    let commit = settings
        .update_config(&app, "complete_onboarding", |config| {
            let was_completed = config.onboarding_completed;
            config.onboarding_completed = true;
            Ok(was_completed)
        })
        .await?;
    let was_completed = commit.value;
    if !was_completed {
        log::info!("[onboarding] completed");
        analytics::track(Event::OnboardingCompleted);
    } else {
        log::info!("[onboarding] completed command ignored; already completed");
    }
    Ok(())
}

/// Tauri 커맨드: 출석 페이지 창을 연다 (온보딩의 "출석 페이지 열기" 버튼용).
/// 트레이 패널의 "출석 페이지 열기"와 동일한 동작.
#[tauri::command]
pub async fn open_attendance_window(app: tauri::AppHandle) {
    tray::open_attendance_window(&app);
    tray::refresh_login_status(&app);
}

fn is_attendance_check_in_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let path = url.path().trim_end_matches('/');
    is_lms_url(&url) && path == "/check-in"
}

fn is_lms_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("jungle-lms.krafton.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_lms_page_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| is_lms_url(&url))
}

pub(crate) fn attendance_cohort_id(
    selected_cohort_id: Option<&str>,
    effective_cohort_id: Option<&str>,
    cohort_options: &[attendance::CohortOption],
) -> Option<String> {
    selected_cohort_id
        .filter(|selected| cohort_options.is_empty() || cohort_options.iter().any(|option| option.id == *selected))
        .or(effective_cohort_id)
        .map(str::to_owned)
}

/// LMS 출석 WebView가 Jungle Bell과 같은 기수를 표시하도록 사용하는 최소 read model.
#[tauri::command]
pub async fn get_attendance_cohort_id(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    page_url: String,
) -> Result<Option<String>, String> {
    if window.label() != "attendance" {
        return Err("허용되지 않은 창입니다.".into());
    }
    if !is_lms_page_url(&page_url) {
        return Err("허용되지 않은 페이지입니다.".into());
    }

    let state = state.lock().await;
    Ok(attendance_cohort_id(
        state.config.selected_cohort_id.as_deref(),
        state.effective_cohort_id.as_deref(),
        &state.cohort_options,
    ))
}

/// 출석 WebView가 감지한 실제 "학습 시작" 클릭을 수신한다.
/// 이 명령은 새로고침하지 않고 hidden checker의 서버 확인만 시작한다.
#[tauri::command]
pub async fn report_attendance_start_clicked(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    page_url: String,
) -> Result<(), String> {
    if window.label() != "attendance" {
        return Err("허용되지 않은 창입니다.".into());
    }
    if !is_attendance_check_in_url(&page_url) {
        return Err("허용되지 않은 페이지입니다.".into());
    }

    let action = {
        let mut state = state.lock().await;
        let morning_checked = state.morning_checked;
        attendance_auto_refresh::request_start_confirmation(&mut state.attendance_auto_refresh, morning_checked)
    };

    match action {
        StartRequestAction::StartPolling { request_id } => {
            log::info!(
                "[attendance-refresh] exact start click observed; waiting for server confirmation: request_id={}",
                request_id,
            );
            attendance_auto_refresh::spawn_confirmation_poll(app, request_id);
        }
        StartRequestAction::AlreadyPending => {
            log::debug!("[attendance-refresh] duplicate start click ignored");
        }
        StartRequestAction::AlreadyConfirmed => {
            log::debug!("[attendance-refresh] start click ignored: attendance already confirmed");
        }
    }

    Ok(())
}

/// 커스텀 트레이 패널이 렌더링할 최신 상태를 반환한다.
#[tauri::command]
pub fn get_tray_panel_state(app: tauri::AppHandle) -> Result<tray::TrayPanelState, String> {
    tray::get_tray_panel_state(&app)
}

#[tauri::command]
pub async fn get_local_dashboard_snapshot(
    local_consumption: tauri::State<'_, Arc<LocalConsumptionService>>,
) -> Result<LocalDashboardSnapshot, String> {
    Ok(local_consumption.dashboard_snapshot().await)
}

#[tauri::command]
pub fn get_alert_overlay_snapshot(
    window: tauri::WebviewWindow,
    alert_overlay: tauri::State<'_, Arc<AlertOverlayService>>,
) -> Result<AlertOverlaySnapshot, String> {
    alert_overlay::ensure_overlay_window(&window)?;
    alert_overlay.snapshot()
}

#[tauri::command]
pub fn dismiss_alert_overlay(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    alert_overlay: tauri::State<'_, Arc<AlertOverlayService>>,
    id: String,
) -> Result<AlertOverlaySnapshot, String> {
    alert_overlay::ensure_overlay_window(&window)?;
    alert_overlay.dismiss(&app, &id)
}

#[tauri::command]
pub fn activate_alert_overlay(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    alert_overlay: tauri::State<'_, Arc<AlertOverlayService>>,
    id: String,
) -> Result<AlertOverlaySnapshot, String> {
    alert_overlay::ensure_overlay_window(&window)?;
    alert_overlay.activate(&app, &id)
}

/// 사용자가 홈 알림 센터에서 선택한 급식 게시 이벤트 하나를 제거한다.
#[tauri::command]
pub async fn dismiss_meal_alert(
    app: tauri::AppHandle,
    local_consumption: tauri::State<'_, Arc<LocalConsumptionService>>,
    alert_id: String,
) -> Result<LocalDashboardSnapshot, String> {
    local_consumption.dismiss_meal_alert(&app, &alert_id).await
}

/// 커스텀 트레이 패널에서 선택한 허용된 액션을 실행한다.
#[tauri::command]
pub fn run_tray_panel_action(app: tauri::AppHandle, action: tray::TrayPanelAction) -> Result<(), String> {
    tray::run_tray_panel_action(&app, action)
}

/// Esc 키 등 패널 내부 요청으로 커스텀 트레이 패널을 숨긴다.
#[tauri::command]
pub fn hide_tray_panel(app: tauri::AppHandle) -> Result<(), String> {
    tray::hide_tray_panel(&app)
}

/// GitHub Pages에 게시된 소식 피드를 1시간 캐시와 함께 반환한다.
#[tauri::command]
pub async fn get_news_feed(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<NewsService>>,
) -> Result<NewsFeed, String> {
    service.get(&app).await
}

/// 피드가 허용한 현재 저장소의 Discussion/Release 링크만 시스템 브라우저로 연다.
#[tauri::command]
pub fn open_news_item(app: tauri::AppHandle, url: String) -> Result<(), String> {
    news::validate_news_url(&url)?;
    tray::hide_tray_panel(&app)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

/// Tauri 커맨드: 현재 로그인 확인 상태 조회.
/// 온보딩 슬라이드 진입 시 초기 표시 여부 결정용.
#[tauri::command]
pub async fn get_login_status(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<LoginStatus, String> {
    let state = state.lock().await;
    Ok(LoginStatus::from_state(&state))
}

/// Tauri 커맨드: hidden checker를 다시 출석 페이지로 이동시켜 로그인 상태를 재확인한다.
/// 온보딩에서 출석 창 로그인 완료를 빠르게 감지하기 위한 보조 커맨드.
#[tauri::command]
pub fn refresh_login_status(app: tauri::AppHandle) {
    tray::refresh_login_status(&app);
}

/// Tauri 커맨드: OS 알림 설정 화면을 연다.
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let targets = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ];

        for target in targets {
            let status = Command::new("open")
                .arg(target)
                .status()
                .map_err(|e| format!("macOS 설정 앱 실행 실패: {}", e))?;
            if status.success() {
                log::info!("[settings] macOS 알림 설정 열기: {}", target);
                return Ok(());
            }
        }

        Err("macOS 알림 설정을 열지 못했습니다.".into())
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:notifications"])
            .status()
            .map_err(|e| format!("Windows 설정 앱 실행 실패: {}", e))?;
        if status.success() {
            log::info!("[settings] Windows 알림 설정 열기");
            return Ok(());
        }

        Err("Windows 알림 설정을 열지 못했습니다.".into())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("이 플랫폼에서는 시스템 알림 설정 바로가기를 지원하지 않습니다.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{attendance_cohort_id, is_attendance_check_in_url, is_lms_page_url, validate_image_asset_url};
    use crate::attendance::CohortOption;

    fn cohort(id: &str) -> CohortOption {
        CohortOption {
            id: id.into(),
            label: id.into(),
            is_active: true,
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
            end_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 7, 30).unwrap()),
        }
    }

    #[test]
    fn 이미지_자산_url은_https와_로컬_assets만_허용한다() {
        assert!(validate_image_asset_url("https://api.example.com/v1/assets/menu.png").is_ok());
        assert!(validate_image_asset_url("http://127.0.0.1:43120/v1/assets/menu.png").is_ok());
        assert!(validate_image_asset_url("http://localhost:43120/v1/assets/menu.png").is_ok());
        assert!(validate_image_asset_url("http://example.com/v1/assets/menu.png").is_err());
        assert!(validate_image_asset_url("https://api.example.com/other/menu.png").is_err());
        assert!(validate_image_asset_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn 자동_새로고침_요청은_정확한_lms_출석_url만_허용한다() {
        assert!(is_attendance_check_in_url("https://jungle-lms.krafton.com/check-in"));
        assert!(is_attendance_check_in_url("https://jungle-lms.krafton.com/check-in/"));
        assert!(!is_attendance_check_in_url("http://jungle-lms.krafton.com/check-in"));
        assert!(!is_attendance_check_in_url(
            "https://jungle-lms.krafton.com.evil.test/check-in"
        ));
        assert!(!is_attendance_check_in_url(
            "https://jungle-lms.krafton.com/check-in/history"
        ));
        assert!(!is_attendance_check_in_url(
            "https://jungle-lms.krafton.com:444/check-in"
        ));
        assert!(!is_attendance_check_in_url(
            "https://user@jungle-lms.krafton.com/check-in"
        ));
    }

    #[test]
    fn 출석창에는_수동_선택을_우선하고_자동선택을_fallback한다() {
        let options = vec![cohort("manual-cohort"), cohort("effective-cohort")];
        assert_eq!(
            attendance_cohort_id(Some("manual-cohort"), Some("effective-cohort"), &options),
            Some("manual-cohort".into())
        );
        assert_eq!(
            attendance_cohort_id(None, Some("effective-cohort"), &options),
            Some("effective-cohort".into())
        );
        assert_eq!(
            attendance_cohort_id(Some("removed-cohort"), Some("effective-cohort"), &options),
            Some("effective-cohort".into())
        );
        assert_eq!(
            attendance_cohort_id(Some("manual-cohort"), None, &[]),
            Some("manual-cohort".into())
        );
        assert_eq!(attendance_cohort_id(None, None, &options), None);
    }

    #[test]
    fn 기수_동기화는_정확한_lms_origin만_허용한다() {
        assert!(is_lms_page_url("https://jungle-lms.krafton.com/check-in"));
        assert!(is_lms_page_url("https://jungle-lms.krafton.com/check-in/history"));
        assert!(!is_lms_page_url("http://jungle-lms.krafton.com/check-in"));
        assert!(!is_lms_page_url("https://jungle-lms.krafton.com.evil.test/check-in"));
        assert!(!is_lms_page_url("https://jungle-lms.krafton.com:444/check-in"));
        assert!(!is_lms_page_url("https://user@jungle-lms.krafton.com/check-in"));
    }
}
