mod analytics;
mod attendance;
mod attendance_day;
mod autostart;
mod checker;
mod commands;
mod config;
mod data_api;
mod desktop_settings;
mod interval_tasks;
#[cfg(desktop)]
mod notification_inbox;
#[cfg(desktop)]
mod notification_service;
mod remote_sync;
mod runtime;
mod scheduler;
mod secure_credential;
mod state;
mod tray;
mod updater;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use config::Config;
use desktop_settings::DesktopSettingsService;
use notification_inbox::NotificationInboxService;
use notification_service::{NotificationRequest, NotificationService};
use state::AppState;

/// 로그 파일 최대 크기 (5 MB). 초과 시 이전 파일 삭제 후 새 파일 시작.
const MAX_LOG_FILE_SIZE: u128 = 5_000_000;
const AUTOSTART_ARGUMENT: &str = "--autostart";

fn should_open_dashboard_on_start(launched_from_autostart: bool) -> bool {
    !launched_from_autostart
}

fn sync_auto_start_setting(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let auto_start = shared_state.try_lock().map(|s| s.config.auto_start).unwrap_or(false);

    if let Err(e) = autostart::sync_auto_start(app, auto_start) {
        let action = if auto_start { "등록" } else { "해제" };
        log::warn!("[app] 자동 시작 {} 실패: {}", action, e);
    }
}

fn notify_startup_status(app: &tauri::AppHandle, notifications: &NotificationService) {
    let current_version = app.package_info().version.to_string();
    let key = format!("app.version-ready:{current_version}");
    let body = format!("Jungle Bell v{current_version}가 준비되었습니다.");
    notifications.deliver(
        app,
        NotificationRequest::system(&key, "Jungle Bell 실행 준비 완료", &body),
    );
}

fn spawn_startup_update_check(app: tauri::AppHandle, state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        if state.lock().await.config.auto_update {
            updater::auto_install_update(app).await;
        }
    });
}

fn spawn_periodic_update_check(app: tauri::AppHandle, state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        const INTERVAL_SECS: u64 = 60 * 60; // 1시간마다 체크
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(INTERVAL_SECS)).await;
            if state.lock().await.config.auto_update {
                updater::auto_install_update(app.clone()).await;
            }
        }
    });
}

const fn configured_log_level(debug_mode: bool) -> log::LevelFilter {
    if debug_mode {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    }
}

/// 앱 진입점.
///
/// Tauri 앱은 기본적으로 보이는 창이 없음 (tauri.conf.json에서 설정).
/// 시스템 트레이 아이콘 + 숨겨진 WebView로 출석 상태를 모니터링한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launched_from_autostart = std::env::args().any(|argument| argument == AUTOSTART_ARGUMENT);
    let config = Config::load();
    let log_level = configured_log_level(config.debug_mode);
    analytics::init(config.usage_analytics);
    let shared_state = Arc::new(Mutex::new(AppState::new(config)));
    let notification_inbox_service = Arc::new(NotificationInboxService::load());
    let notification_service = Arc::new(NotificationService::new(notification_inbox_service.clone()));
    let settings_service = Arc::new(DesktopSettingsService::new(shared_state.clone()));

    tauri::Builder::default()
        // single-instance 플러그인: 공식 문서 권장대로 가장 먼저 등록한다.
        // 이미 실행 중인 인스턴스가 있으면 두 번째 실행을 차단한다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("[app] 다른 인스턴스 실행이 감지되어 차단되었습니다");
            tray::open_dashboard_window(app);
        }))
        // 로그 플러그인: stdout(터미널) + 파일(플랫폼 로그 디렉터리) 동시 출력.
        // KeepOne 전략으로 500KB 초과 시 이전 파일 삭제 → 최대 ~1MB 유지.
        // 로그 위치: macOS ~/Library/Logs/dev.sijun-yang.jungle-bell/
        //            Windows %APPDATA%\dev.sijun-yang.jungle-bell\logs\
        .plugin(
            tauri_plugin_log::Builder::new()
                // 런타임에서 디버그 모드를 켤 수 있도록 백엔드는 Debug까지 받는다.
                // 실제 출력 상한은 setup과 설정 command에서 set_max_level로 제어한다.
                .level(log::LevelFilter::Debug)
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
            Some(vec![AUTOSTART_ARGUMENT]),
        ))
        // opener 플러그인: 검증된 공개 링크를 시스템 브라우저로 연다.
        .plugin(tauri_plugin_opener::init())
        // updater 플러그인: 자동 업데이트 지원
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(checker::navigation_guard())
        // AppState를 Tauri의 managed state로 등록.
        // 핸들러에서 `tauri::State<Arc<Mutex<AppState>>>`로 받아 사용.
        .manage(shared_state.clone())
        .manage(notification_inbox_service.clone())
        .manage(notification_service.clone())
        .manage(settings_service)
        // JS에서 `window.__TAURI__.core.invoke()`로 호출할 수 있는 Tauri 커맨드 등록.
        .invoke_handler(tauri::generate_handler![
            commands::report_checker_event,
            commands::bootstrap_desktop_http_session,
            commands::get_desktop_settings,
            commands::update_desktop_settings,
            commands::open_log_folder,
            commands::get_notification_inbox_snapshot,
            commands::mark_notification_read,
            commands::activate_notification,
            commands::send_test_notification,
            commands::get_connected_service_status,
            commands::reset_desktop_identity,
            commands::open_lms_login,
            commands::refresh_platform_sync,
        ])
        // setup(): 앱 초기화 후 이벤트 루프 시작 전에 한 번 실행.
        .setup(move |app| {
            log::set_max_level(log_level);
            log::info!(
                "[app] starting v{} (log_level={}, log_max_size={}KB)",
                app.package_info().version,
                log_level,
                MAX_LOG_FILE_SIZE / 1000,
            );
            // 자동 시작: 현재 설정값만 OS 상태와 동기화한다. 기본값은 꺼짐이다.
            sync_auto_start_setting(app.handle(), &shared_state);
            let remote_sync_service = Arc::new(tauri::async_runtime::block_on(
                remote_sync::RemoteSyncService::configured(app.handle()),
            )?);
            let analytics_installation_id =
                tauri::async_runtime::block_on(remote_sync_service.installation_id_for_analytics());
            analytics::set_identity(&analytics_installation_id);
            app.manage(remote_sync_service.clone());
            tray::setup_tray(app)?;
            if let Err(error) = notification_service.initialize_system_backend() {
                log::warn!("[notification] OS backend initialization failed: {error}");
            }
            let checker_window = checker::build_webview(app.handle())?;
            // macOS Dock 배지는 윈도우 API를 통해 앱 전역으로 설정되므로,
            // 자동 시작에서도 존재하는 checker를 만든 뒤 초기 배지를 동기화한다.
            notification_inbox_service.initialize(app.handle());
            match checker_window.theme() {
                Ok(theme) => {
                    if let Err(error) = tray::sync_icon_theme(app.handle(), theme) {
                        log::warn!("[app] initial tray theme sync failed: {error}");
                    }
                }
                Err(error) => log::warn!("[app] system theme detection failed: {error}"),
            }
            notify_startup_status(app.handle(), &notification_service);
            if should_open_dashboard_on_start(launched_from_autostart) {
                tray::open_dashboard_window(app.handle());
            }
            spawn_startup_update_check(app.handle().clone(), shared_state.clone());
            spawn_periodic_update_check(app.handle().clone(), shared_state.clone());

            // 백그라운드 루프: 상태 계산, 트레이 갱신, 체커 주기적 리로드.
            let app_handle = app.handle().clone();
            scheduler::start_scheduler(app_handle, shared_state.clone());
            remote_sync::start_background_loop(
                app.handle().clone(),
                remote_sync_service,
                shared_state.clone(),
                notification_service.clone(),
            );

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 자동시작은_대시보드를_열지_않고_수동실행은_연다() {
        assert!(should_open_dashboard_on_start(false));
        assert!(!should_open_dashboard_on_start(true));
    }

    #[test]
    fn 디버그_모드는_런타임_로그_상한을_전환한다() {
        assert_eq!(configured_log_level(false), log::LevelFilter::Info);
        assert_eq!(configured_log_level(true), log::LevelFilter::Debug);
    }

    #[test]
    fn dashboard_csp는_정확한_api_worker만_연결하고_wildcard를_허용하지_않는다() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("https://jungle-bell-api.yangsijun5528.workers.dev"));
        assert!(csp.contains("https://jungle-bell-api-test.yangsijun5528.workers.dev"));
        assert!(!csp.contains("*.workers.dev"));
        assert!(!csp.contains("connect-src *"));
    }

    #[test]
    fn native_command_manifest는_os경계_12개와_http_bootstrap만_남긴다() {
        let build = include_str!("../build.rs");
        let manifest = build
            .split("const APP_COMMANDS")
            .nth(1)
            .unwrap()
            .split("];")
            .next()
            .unwrap();
        let commands = manifest
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "activate_notification",
            "bootstrap_desktop_http_session",
            "get_connected_service_status",
            "get_desktop_settings",
            "get_notification_inbox_snapshot",
            "mark_notification_read",
            "open_lms_login",
            "open_log_folder",
            "refresh_platform_sync",
            "report_checker_event",
            "reset_desktop_identity",
            "send_test_notification",
            "update_desktop_settings",
        ]
        .into_iter()
        .collect();
        assert_eq!(commands, expected);
    }
}
