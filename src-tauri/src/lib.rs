mod analytics;
mod attendance_day;
mod autostart;
mod checker;
mod commands;
mod config;
mod scheduler;
mod state;
mod tray;
mod updater;

use std::sync::Arc;
use tokio::sync::Mutex;

use tauri::Manager;

use config::Config;
use state::AppState;

/// 로그 파일 최대 크기 (5 MB). 초과 시 이전 파일 삭제 후 새 파일 시작.
const MAX_LOG_FILE_SIZE: u128 = 5_000_000;

fn sync_auto_start_setting(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let auto_start = shared_state.try_lock().map(|s| s.config.auto_start).unwrap_or(true);

    if let Err(e) = autostart::sync_auto_start(app, auto_start) {
        let action = if auto_start { "등록" } else { "해제" };
        log::warn!("[app] 자동 시작 {} 실패: {}", action, e);
    }
}

fn notify_startup_status(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    use tauri_plugin_notification::NotificationExt;

    let mut state = shared_state.try_lock().unwrap();
    let current_version = app.package_info().version.to_string();

    match &state.config.last_version {
        None => {
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 설치 완료")
                .body("트레이 아이콘에서 출석 창을 열고 LMS에 로그인해 주세요.")
                .show();
            log::info!("[app] 환영 알림 발송 (첫 설치)");
            tray::open_onboarding_window(app);
        }
        Some(last) if last != &current_version => {
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 업데이트 완료")
                .body(&format!("v{} → v{}로 업데이트되었습니다.", last, current_version))
                .show();
            log::info!("[app] 업데이트 완료 알림 발송: v{} → v{}", last, current_version);
        }
        _ => {}
    }

    state.config.last_version = Some(current_version);
    state.config.welcome_notification_sent = true;
    state.config.save();
}

fn build_checker_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let checker_script = include_str!("../../src/checker.js");
    let checker = tauri::WebviewWindowBuilder::new(
        app,
        "checker",
        tauri::WebviewUrl::External("https://jungle-lms.krafton.com/check-in".parse().unwrap()),
    )
    .title("Jungle Bell")
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .initialization_script(checker_script)
    .build()?;

    let app_handle = app.clone();
    checker.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("checker") {
                let _ = window.hide();
            }
        }
    });

    Ok(checker)
}

fn spawn_startup_update_check(app: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        let auto_update = shared_state.lock().await.config.auto_update;
        if auto_update {
            updater::auto_install_update(app).await;
        } else {
            updater::check_and_store_pending_update(&app, &shared_state).await;
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
        // JS에서 `window.__TAURI__.core.invoke()`로 호출할 수 있는 Tauri 커맨드 등록.
        .invoke_handler(tauri::generate_handler![
            commands::report_attendance_status,
            commands::report_cms_identity,
            commands::log_from_js,
            commands::get_auto_update,
            commands::set_auto_update,
            commands::get_app_version,
            commands::get_pending_update,
            commands::check_and_notify_update,
            commands::get_auto_start,
            commands::set_auto_start,
            commands::get_start_notification_enabled,
            commands::set_start_notification_enabled,
            commands::get_end_notification_enabled,
            commands::set_end_notification_enabled,
            commands::get_start_notification_interval,
            commands::set_start_notification_interval,
            commands::get_end_notification_interval,
            commands::set_end_notification_interval,
            commands::get_notification_start,
            commands::set_notification_start,
            commands::get_notification_end,
            commands::set_notification_end,
            commands::get_skip_attendance,
            commands::set_skip_attendance,
            commands::get_skip_sunday,
            commands::set_skip_sunday,
            commands::open_notification_settings,
            commands::get_debug_mode,
            commands::set_debug_mode,
            commands::open_log_folder,
            commands::open_onboarding,
            commands::close_onboarding,
            commands::open_attendance_window,
            commands::get_login_status,
            commands::refresh_login_status,
        ])
        // setup(): 앱 초기화 후 이벤트 루프 시작 전에 한 번 실행.
        .setup(move |app| {
            log::info!(
                "[app] starting v{} (log_level={}, log_max_size={}KB)",
                app.package_info().version,
                log_level,
                MAX_LOG_FILE_SIZE / 1000,
            );

            // 분석: PostHog 클라이언트 초기화.
            // app_opened 이벤트는 identity 설정 시(set_identity) 전송한다.
            analytics::init();

            // 자동 시작: Config 값을 기준으로 OS 상태를 동기화.
            // 기본값이 true이므로 첫 설치 시 자동으로 등록됨.
            sync_auto_start_setting(app.handle(), &shared_state);
            tray::setup_tray(app)?;
            build_checker_window(app.handle())?;
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
