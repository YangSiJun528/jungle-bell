mod alert_overlay;
mod analytics;
mod attendance;
mod attendance_auto_refresh;
mod attendance_day;
mod autostart;
mod campus;
mod checker;
mod commands;
mod config;
mod data_api;
mod interval_tasks;
mod local_consumption;
mod news;
mod runtime;
mod scheduler;
mod settings_state;
mod state;
mod tray;
mod updater;

use std::sync::Arc;
use tokio::sync::Mutex;

use alert_overlay::AlertOverlayService;
use config::Config;
use local_consumption::LocalConsumptionService;
use settings_state::SettingsService;
use state::AppState;

/// 로그 파일 최대 크기 (5 MB). 초과 시 이전 파일 삭제 후 새 파일 시작.
const MAX_LOG_FILE_SIZE: u128 = 5_000_000;

#[cfg(desktop)]
fn window_size_should_persist(label: &str) -> bool {
    label == "image-viewer"
}

#[cfg(desktop)]
fn persisted_window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::SIZE
}

fn sync_auto_start_setting(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let auto_start = shared_state.try_lock().map(|s| s.config.auto_start).unwrap_or(true);

    if let Err(e) = autostart::sync_auto_start(app, auto_start) {
        let action = if auto_start { "등록" } else { "해제" };
        log::warn!("[app] 자동 시작 {} 실패: {}", action, e);
    }
}

fn notify_startup_status(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    use tauri_plugin_notification::NotificationExt;

    let current = shared_state.try_lock().unwrap().config.clone();
    let current_version = app.package_info().version.to_string();
    let should_open_onboarding = !current.onboarding_completed;

    match &current.last_version {
        None => {
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 설치 완료")
                .body("트레이 아이콘에서 출석 창을 열고 LMS에 로그인해 주세요.")
                .show();
            log::info!("[app] 환영 알림 발송 (첫 설치)");
        }
        Some(last) if last != &current_version => {
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 업데이트 완료")
                .body(format!("v{} → v{}로 업데이트되었습니다.", last, current_version))
                .show();
            log::info!("[app] 업데이트 완료 알림 발송: v{} → v{}", last, current_version);
            analytics::prepare_app_updated(last.clone(), current_version.clone());
        }
        _ => {}
    }

    let mut next = current.clone();
    next.last_version = Some(current_version);
    next.welcome_notification_sent = true;
    match next.save() {
        Ok(()) => {
            let mut state = shared_state.try_lock().unwrap();
            if state.config != current {
                log::warn!("[app] 시작 상태 저장 중 config가 변경되어 최신 시작 snapshot으로 재동기화");
            }
            state.config = next;
        }
        Err(error) => log::error!("[app] 시작 상태 저장 실패: {error}"),
    }

    if should_open_onboarding {
        tray::open_onboarding_window(app);
    }
}

fn spawn_startup_update_check(app: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        let auto_update = shared_state.lock().await.config.auto_update;
        if auto_update {
            updater::auto_install_update(app).await;
        } else {
            updater::check_and_store_pending_update(&app).await;
        }
    });
}

fn spawn_periodic_update_check(app: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        const INTERVAL_SECS: u64 = 60 * 60; // 1시간마다 체크
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(INTERVAL_SECS)).await;
            updater::check_update_periodic(&app, &shared_state).await;
        }
    });
}

/// 앱 진입점.
///
/// Tauri 앱은 기본적으로 보이는 창이 없음 (tauri.conf.json에서 설정).
/// 시스템 트레이 아이콘 + 숨겨진 WebView로 출석 상태를 모니터링한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = Config::load();
    let log_level = if config.debug_mode {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let shared_state = Arc::new(Mutex::new(AppState::new(config)));
    let alert_overlay_service = Arc::new(AlertOverlayService::default());
    let settings_service = Arc::new(SettingsService::new(
        shared_state.clone(),
        env!("CARGO_PKG_VERSION").to_string(),
    ));
    let local_consumption_service = Arc::new(LocalConsumptionService::new(
        shared_state.clone(),
        alert_overlay_service.clone(),
    ));
    let campus_service = Arc::new(campus::CampusService::new());
    let news_service = Arc::new(news::NewsService::new());

    tauri::Builder::default()
        // single-instance 플러그인: 공식 문서 권장대로 가장 먼저 등록한다.
        // 이미 실행 중인 인스턴스가 있으면 두 번째 실행을 차단한다.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            log::info!("[app] 다른 인스턴스 실행이 감지되어 차단되었습니다");
        }))
        // 로그 플러그인: stdout(터미널) + 파일(플랫폼 로그 디렉터리) 동시 출력.
        // KeepOne 전략으로 500KB 초과 시 이전 파일 삭제 → 최대 ~1MB 유지.
        // 로그 위치: macOS ~/Library/Logs/dev.sijun-yang.jungle-bell/
        //            Windows %APPDATA%\dev.sijun-yang.jungle-bell\logs\
        // debug_mode가 활성화되면 Debug 레벨까지 출력.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .max_file_size(MAX_LOG_FILE_SIZE)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .format(|callback, message, record| {
                    let now = chrono::Local::now();
                    callback.finish(format_args!(
                        "[{}][v{}][{}][{}] {}",
                        now.format("%Y-%m-%d %H:%M:%S"),
                        env!("CARGO_PKG_VERSION"),
                        record.level(),
                        record.target(),
                        message,
                    ))
                })
                .build(),
        )
        // autostart 플러그인: 시스템 시작 시 앱 자동 실행 (macOS: LaunchAgent)
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // opener 플러그인: 시스템 브라우저로 URL 열기 (설정 페이지에서 사용)
        .plugin(tauri_plugin_opener::init())
        // updater 플러그인: 자동 업데이트 지원
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // notification 플러그인: OS 네이티브 알림 지원
        .plugin(tauri_plugin_notification::init())
        // AppState를 Tauri의 managed state로 등록.
        // 핸들러에서 `tauri::State<Arc<Mutex<AppState>>>`로 받아 사용.
        .manage(shared_state.clone())
        .manage(alert_overlay_service)
        .manage(settings_service)
        .manage(local_consumption_service)
        .manage(campus_service.clone())
        .manage(news_service)
        // JS에서 `window.__TAURI__.core.invoke()`로 호출할 수 있는 Tauri 커맨드 등록.
        .invoke_handler(tauri::generate_handler![
            commands::report_attendance_status,
            commands::report_checker_ready,
            commands::report_cms_identity,
            commands::log_from_js,
            commands::get_settings_snapshot,
            commands::resolve_cohort_selection,
            commands::set_selected_cohort,
            commands::set_auto_update,
            commands::report_campus_ready,
            commands::report_campus_interaction,
            commands::refresh_campus_data,
            commands::load_meal_history,
            commands::open_image_viewer,
            commands::check_and_notify_update,
            commands::set_auto_start,
            commands::set_start_notification_enabled,
            commands::set_end_notification_enabled,
            commands::set_notification_delivery,
            commands::set_meal_subscription_enabled,
            commands::set_laundry_watch,
            commands::set_start_notification_interval,
            commands::set_end_notification_interval,
            commands::set_notification_start,
            commands::set_notification_end,
            commands::set_skip_attendance,
            commands::set_skip_sunday,
            commands::open_notification_settings,
            commands::set_debug_mode,
            commands::get_usage_analytics_enabled,
            commands::set_usage_analytics_enabled,
            commands::set_show_dday,
            commands::set_show_app_icon,
            commands::open_log_folder,
            commands::open_onboarding,
            commands::complete_onboarding,
            commands::open_attendance_window,
            commands::get_attendance_cohort_id,
            commands::report_attendance_start_clicked,
            commands::get_tray_panel_state,
            commands::get_local_dashboard_snapshot,
            commands::dismiss_meal_alert,
            commands::run_tray_panel_action,
            commands::hide_tray_panel,
            commands::get_news_feed,
            commands::open_news_item,
            commands::get_login_status,
            commands::refresh_login_status,
            commands::get_alert_overlay_snapshot,
            commands::dismiss_alert_overlay,
            commands::activate_alert_overlay,
        ])
        // setup(): 앱 초기화 후 이벤트 루프 시작 전에 한 번 실행.
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(persisted_window_state_flags())
                    .with_filter(window_size_should_persist)
                    .build(),
            )?;

            log::info!(
                "[app] starting v{} (log_level={}, log_max_size={}KB)",
                app.package_info().version,
                log_level,
                MAX_LOG_FILE_SIZE / 1000,
            );
            // 분석: PostHog 클라이언트 초기화.
            // app_opened 이벤트는 identity 설정 시(set_identity) 전송한다.
            let usage_analytics_enabled = {
                let state = shared_state.try_lock().unwrap();
                state.config.usage_analytics_enabled
            };
            analytics::init(usage_analytics_enabled);

            // 자동 시작: Config 값을 기준으로 OS 상태를 동기화.
            // 기본값이 true이므로 첫 설치 시 자동으로 등록됨.
            sync_auto_start_setting(app.handle(), &shared_state);
            tray::setup_tray(app)?;
            let checker_window = checker::build_webview(app.handle())?;
            match checker_window.theme() {
                Ok(theme) => {
                    if let Err(error) = tray::sync_icon_theme(app.handle(), theme) {
                        log::warn!("[app] initial tray theme sync failed: {error}");
                    }
                }
                Err(error) => log::warn!("[app] system theme detection failed: {error}"),
            }
            notify_startup_status(app.handle(), &shared_state);
            spawn_startup_update_check(app.handle().clone(), shared_state.clone());
            spawn_periodic_update_check(app.handle().clone(), shared_state.clone());

            // 백그라운드 루프: 상태 계산, 트레이 갱신, 체커 주기적 리로드.
            let app_handle = app.handle().clone();
            scheduler::start_scheduler(app_handle, shared_state.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn 이미지_뷰어만_변경한_크기를_기억한다() {
        assert!(!window_size_should_persist("attendance"));
        assert!(window_size_should_persist("image-viewer"));
        assert!(!window_size_should_persist("campus"));
        assert!(!window_size_should_persist("settings"));
        assert!(!window_size_should_persist("alert-overlay"));
        assert!(!window_size_should_persist("tray-panel"));
    }

    #[test]
    fn 창_상태는_위치나_최대화가_아닌_크기만_저장한다() {
        let flags = persisted_window_state_flags();
        assert_eq!(flags.bits(), StateFlags::SIZE.bits());
        assert!(!flags.contains(StateFlags::POSITION));
        assert!(!flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags.contains(StateFlags::VISIBLE));
    }
}
