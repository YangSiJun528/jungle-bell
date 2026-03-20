mod checker;
mod config;
mod scheduler;
mod state;
mod tray;

use std::sync::Arc;
use tokio::sync::Mutex;

use tauri::Manager;

use config::Config;
use state::AppState;

/// 로그 파일 최대 크기 (5 MB). 초과 시 이전 파일 삭제 후 새 파일 시작.
const MAX_LOG_FILE_SIZE: u128 = 5_000_000;

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
        // single-instance 플러그인: 이미 실행 중인 인스턴스가 있으면 두 번째 실행을 차단.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            log::info!("[app] 다른 인스턴스 실행이 감지되어 차단되었습니다");
        }))
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
            checker::report_attendance_status,
            checker::log_from_js,
            checker::get_auto_update,
            checker::set_auto_update,
            checker::get_app_version,
            checker::check_and_notify_update,
            checker::get_auto_start,
            checker::set_auto_start,
            checker::get_start_notification_enabled,
            checker::set_start_notification_enabled,
            checker::get_end_notification_enabled,
            checker::set_end_notification_enabled,
            checker::get_start_notification_interval,
            checker::set_start_notification_interval,
            checker::get_end_notification_interval,
            checker::set_end_notification_interval,
            checker::get_notification_start,
            checker::set_notification_start,
            checker::get_notification_end,
            checker::set_notification_end,
            checker::get_skip_attendance,
            checker::set_skip_attendance,
            checker::get_skip_sunday,
            checker::set_skip_sunday,
            checker::open_notification_settings,
            checker::get_debug_mode,
            checker::set_debug_mode,
            checker::open_log_folder,
        ])
        // setup(): 앱 초기화 후 이벤트 루프 시작 전에 한 번 실행.
        .setup(move |app| {
            log::info!(
                "[app] starting v{} (log_level={}, log_max_size={}KB)",
                app.package_info().version,
                log_level,
                MAX_LOG_FILE_SIZE / 1000,
            );

            // 자동 시작: Config 값을 기준으로 OS 상태를 동기화.
            // 기본값이 true이므로 첫 설치 시 자동으로 등록됨.
            {
                use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
                let auto_start = shared_state.try_lock().map(|s| s.config.auto_start).unwrap_or(true);
                let autolaunch = app.autolaunch();
                if auto_start {
                    if let Err(e) = autolaunch.enable() {
                        log::warn!("[app] 자동 시작 등록 실패: {}", e);
                    }
                } else if let Err(e) = autolaunch.disable() {
                    log::warn!("[app] 자동 시작 해제 실패: {}", e);
                }
            }

            tray::setup_tray(app)?;

            // 환영 알림 또는 업데이트 완료 알림.
            // - last_version이 None이면 첫 설치 → 환영 알림 (로그인 요청)
            // - last_version이 현재 버전과 다르면 업데이트 완료 → 업데이트 알림
            // - 같으면 일반 시작 → 알림 없음
            {
                use tauri_plugin_notification::NotificationExt;
                let mut state = shared_state.try_lock().unwrap();
                let current_version = app.package_info().version.to_string();

                match &state.config.last_version {
                    None => {
                        // 첫 설치: 로그인 요청 알림
                        let _ = app.notification()
                            .builder()
                            .title("Jungle Bell 설치 완료")
                            .body("트레이 아이콘에서 출석 창을 열고 LMS에 로그인해 주세요.")
                            .show();
                        log::info!("[app] 환영 알림 발송 (첫 설치)");
                    }
                    Some(last) if last != &current_version => {
                        // 업데이트 완료
                        let _ = app.notification()
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

            // 숨겨진 WebView로 LMS 출석 페이지를 로드.
            // checker.js가 initialization_script로 주입되어 DOM을 읽고,
            // invoke()를 통해 Rust 쪽으로 출석 상태를 보고한다.
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
            // initialization_script: 이 WebView의 모든 페이지 로드 시 실행되는 JS
            .initialization_script(checker_script)
            .build()?;

            // 체커 WebView가 닫히면 숨기기만 함 (출석 모니터링을 계속하기 위해).
            let app_handle_close = app.handle().clone();
            checker.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = app_handle_close.get_webview_window("checker") {
                        let _ = w.hide();
                    }
                }
            });

            // 시작 시 업데이트 확인 (백그라운드). auto_update 설정이 꺼져 있으면 건너뜀.
            let app_handle_update = app.handle().clone();
            let shared_state_update = shared_state.clone();
            tauri::async_runtime::spawn(async move {
                let auto_update = shared_state_update.lock().await.config.auto_update;
                if !auto_update {
                    return;
                }
                checker::prompt_and_install_update(app_handle_update, true).await;
            });

            // 백그라운드 루프: 상태 계산, 트레이 갱신, 체커 주기적 리로드.
            let app_handle = app.handle().clone();
            scheduler::start_scheduler(app_handle, shared_state.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
