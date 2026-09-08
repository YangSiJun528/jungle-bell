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

use std::sync::{Arc, Mutex as StdMutex};
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

#[derive(Default)]
struct StartupNotificationState {
    event_loop_ready: bool,
    runtime_started: bool,
    notification_emitted: bool,
}

impl StartupNotificationState {
    fn mark_event_loop_ready(&mut self) -> bool {
        self.event_loop_ready = true;
        self.take_notification_permission()
    }

    fn mark_runtime_started(&mut self) -> bool {
        self.runtime_started = true;
        self.take_notification_permission()
    }

    fn take_notification_permission(&mut self) -> bool {
        if self.event_loop_ready && self.runtime_started && !self.notification_emitted {
            self.notification_emitted = true;
            true
        } else {
            false
        }
    }
}

enum StartupNotificationMilestone {
    EventLoopReady,
    RuntimeStarted,
}

fn notify_startup_status_after(
    app: &tauri::AppHandle,
    notifications: &NotificationService,
    state: &StdMutex<StartupNotificationState>,
    milestone: StartupNotificationMilestone,
) {
    let should_notify = {
        let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match milestone {
            StartupNotificationMilestone::EventLoopReady => state.mark_event_loop_ready(),
            StartupNotificationMilestone::RuntimeStarted => state.mark_runtime_started(),
        }
    };

    if should_notify {
        notify_startup_status(app, notifications);
    }
}

#[derive(Clone)]
struct RuntimeServices {
    state: Arc<Mutex<AppState>>,
    notification_inbox: Arc<NotificationInboxService>,
    notifications: Arc<NotificationService>,
    settings: Arc<DesktopSettingsService>,
    remote_sync: Arc<remote_sync::RemoteSyncService>,
    updater: Arc<updater::UpdateCoordinator>,
}

fn spawn_initial_update_check(app: tauri::AppHandle, updater: Arc<updater::UpdateCoordinator>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = updater.check_update(&app).await {
            log::warn!("[updater] 시작 업데이트 확인 중단: {error}");
        }
    });
}

fn spawn_pending_update_preflight(
    app: tauri::AppHandle,
    services: RuntimeServices,
    startup_notification_state: Arc<StdMutex<StartupNotificationState>>,
    opens_dashboard: bool,
) {
    tauri::async_runtime::spawn(async move {
        let outcome = services.updater.apply_pending_update_on_start(app.clone()).await;
        if outcome == updater::AutoUpdateOutcome::RestartRequested {
            return;
        }

        let app_handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Err(error) = finish_runtime_startup(
                &app_handle,
                services,
                startup_notification_state.as_ref(),
                opens_dashboard,
                false,
            ) {
                log::error!("[app] pending update 이후 런타임 초기화 실패: {error}");
                app_handle.exit(1);
            }
        }) {
            log::error!("[app] pending update 이후 런타임 초기화 예약 실패: {error}");
            app.exit(1);
        }
    });
}

fn spawn_periodic_update_check(app: tauri::AppHandle, updater: Arc<updater::UpdateCoordinator>) {
    tauri::async_runtime::spawn(async move {
        const INTERVAL_SECS: u64 = 60 * 60; // 1시간마다 체크
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(INTERVAL_SECS)).await;
            if let Err(error) = updater.refresh_update(&app).await {
                log::warn!("[updater] 주기적 업데이트 확인 중단: {error}");
            }
        }
    });
}

fn finish_runtime_startup(
    app: &tauri::AppHandle,
    services: RuntimeServices,
    startup_notification_state: &StdMutex<StartupNotificationState>,
    opens_dashboard: bool,
    refresh_update_on_start: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    tray::setup_tray(app)?;
    if let Err(error) = services.notifications.initialize_system_backend() {
        log::warn!("[notification] OS backend initialization failed: {error}");
    }
    let checker_window = checker::build_webview(app)?;
    // macOS Dock 배지는 윈도우 API를 통해 앱 전역으로 설정되므로,
    // 자동 시작에서도 존재하는 checker를 만든 뒤 초기 배지를 동기화한다.
    services.notification_inbox.initialize(app);
    match checker_window.theme() {
        Ok(theme) => {
            if let Err(error) = tray::sync_icon_theme(app, theme) {
                log::warn!("[app] initial tray theme sync failed: {error}");
            }
        }
        Err(error) => log::warn!("[app] system theme detection failed: {error}"),
    }
    notify_startup_status_after(
        app,
        &services.notifications,
        startup_notification_state,
        StartupNotificationMilestone::RuntimeStarted,
    );
    if refresh_update_on_start {
        // 프런트엔드 조회와 같은 coordinator/cache를 사용해 시작 직후 원격
        // endpoint를 중복 호출하지 않는다.
        spawn_initial_update_check(app.clone(), services.updater.clone());
    }
    if opens_dashboard {
        tray::open_dashboard_window(app);
    }
    spawn_periodic_update_check(app.clone(), services.updater.clone());
    scheduler::start_scheduler(app.clone(), services.state.clone());
    remote_sync::start_background_loop(
        app.clone(),
        services.remote_sync,
        services.settings,
        services.state,
        services.notifications,
    );
    Ok(())
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
    let loaded_config = Config::load();
    let config = loaded_config.config.clone();
    let log_level = configured_log_level(config.debug_mode);
    let shared_state = Arc::new(Mutex::new(AppState::new(config)));
    let notification_inbox_service = Arc::new(NotificationInboxService::load());
    let notification_service = Arc::new(NotificationService::new(notification_inbox_service.clone()));
    let startup_notification_state = Arc::new(StdMutex::new(StartupNotificationState::default()));
    let setup_startup_notification_state = startup_notification_state.clone();
    let event_loop_notification_service = notification_service.clone();
    let settings_service = Arc::new(DesktopSettingsService::new(shared_state.clone()));
    let lifecycle_state = Arc::new(config::DesktopLifecycleStateStore::load());

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
        .manage(settings_service.clone())
        .manage(lifecycle_state)
        // JS에서 `window.__TAURI__.core.invoke()`로 호출할 수 있는 Tauri 커맨드 등록.
        .invoke_handler(tauri::generate_handler![
            commands::report_checker_event,
            commands::get_desktop_lifecycle_status,
            commands::acknowledge_and_hide_to_tray,
            commands::quit_desktop_app,
            commands::bootstrap_desktop_http_session,
            commands::get_desktop_settings,
            commands::check_desktop_update,
            commands::install_desktop_update,
            commands::update_desktop_settings,
            commands::open_log_folder,
            commands::open_system_notification_settings,
            commands::get_notification_inbox_snapshot,
            commands::mark_notification_read,
            commands::mark_all_notifications_read,
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
            let startup_usage = loaded_config.startup_usage_analytics(remote_sync_service.clean_new_installation());
            let effective_usage = if startup_usage != loaded_config.config.usage_analytics {
                match tauri::async_runtime::block_on(settings_service.initialize_usage_analytics(startup_usage)) {
                    Ok(saved) => saved.usage_analytics,
                    Err(error) => {
                        log::warn!("[usage] 신규 설치 통계 기본값 저장 실패로 전송을 비활성화합니다: {error}");
                        None
                    }
                }
            } else {
                loaded_config.config.usage_analytics
            };
            let runtime_usage = loaded_config.runtime_usage_analytics(effective_usage);
            tauri::async_runtime::block_on(remote_sync_service.set_usage_analytics_preference(runtime_usage));
            app.manage(remote_sync_service.clone());
            let update_coordinator = Arc::new(updater::UpdateCoordinator::new(app.handle())?);
            let pending_update_on_start = tauri::async_runtime::block_on(update_coordinator.has_pending_auto_install());
            app.manage(update_coordinator.clone());
            let opens_dashboard = should_open_dashboard_on_start(launched_from_autostart);
            let runtime_services = RuntimeServices {
                state: shared_state.clone(),
                notification_inbox: notification_inbox_service.clone(),
                notifications: notification_service.clone(),
                settings: settings_service.clone(),
                remote_sync: remote_sync_service,
                updater: update_coordinator,
            };

            if pending_update_on_start {
                // Windows installer는 프로세스를 즉시 끝낼 수 있으므로 tray,
                // checker, ready 알림, 백그라운드 루프보다 먼저 처리한다.
                spawn_pending_update_preflight(
                    app.handle().clone(),
                    runtime_services,
                    setup_startup_notification_state.clone(),
                    opens_dashboard,
                );
            } else {
                finish_runtime_startup(
                    app.handle(),
                    runtime_services,
                    setup_startup_notification_state.as_ref(),
                    opens_dashboard,
                    true,
                )?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app, event| {
            if let tauri::RunEvent::Ready = event {
                notify_startup_status_after(
                    app,
                    &event_loop_notification_service,
                    startup_notification_state.as_ref(),
                    StartupNotificationMilestone::EventLoopReady,
                );
            }
        });
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
    fn 시작_알림은_런타임초기화와_event_loop_ready_후_한번만_허용한다() {
        let mut state = StartupNotificationState::default();

        assert!(!state.mark_runtime_started());
        assert!(state.mark_event_loop_ready());
        assert!(!state.mark_event_loop_ready());
        assert!(!state.mark_runtime_started());
    }

    #[test]
    fn 지연된_런타임초기화도_event_loop_ready_후_한번만_허용한다() {
        let mut state = StartupNotificationState::default();

        assert!(!state.mark_event_loop_ready());
        assert!(state.mark_runtime_started());
        assert!(!state.mark_runtime_started());
        assert!(!state.mark_event_loop_ready());
    }

    #[test]
    fn dashboard_csp는_정확한_운영_api만_연결하고_wildcard를_허용하지_않는다() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("https://jungle-bell.sijun-yang.com"));
        assert!(!csp.contains("workers.dev"));
        assert!(!csp.contains("*.workers.dev"));
        assert!(!csp.contains("connect-src *"));
    }

    #[test]
    fn native_command_manifest는_허용된_os경계와_http_bootstrap만_남긴다() {
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
            "acknowledge_and_hide_to_tray",
            "activate_notification",
            "bootstrap_desktop_http_session",
            "check_desktop_update",
            "get_connected_service_status",
            "get_desktop_lifecycle_status",
            "get_desktop_settings",
            "get_notification_inbox_snapshot",
            "mark_all_notifications_read",
            "mark_notification_read",
            "install_desktop_update",
            "open_lms_login",
            "open_log_folder",
            "open_system_notification_settings",
            "refresh_platform_sync",
            "report_checker_event",
            "reset_desktop_identity",
            "send_test_notification",
            "quit_desktop_app",
            "update_desktop_settings",
        ]
        .into_iter()
        .collect();
        assert_eq!(commands, expected);
    }
}
