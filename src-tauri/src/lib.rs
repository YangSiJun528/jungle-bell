mod checker;
mod config;
mod scheduler;
mod state;
mod tray;

use std::sync::Arc;
use tokio::sync::Mutex;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

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
                    callback.finish(format_args!(
                        "[v{}][{}][{}] {}",
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
            checker::get_notification_enabled,
            checker::set_notification_enabled,
            checker::get_notification_interval,
            checker::set_notification_interval,
            checker::get_notification_start,
            checker::set_notification_start,
            checker::get_notification_end,
            checker::set_notification_end,
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
            // 업데이트가 있으면 사용자에게 다이얼로그로 알리고 설치 여부를 선택하게 함.
            // 시작 시 업데이트 확인 (백그라운드).
            let app_handle_update = app.handle().clone();
            let shared_state_update = shared_state.clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

                let auto_update = shared_state_update.lock().await.config.auto_update;
                if !auto_update {
                    return;
                }
                if let Ok(updater) = app_handle_update.updater() {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            log::info!("[updater] 새 업데이트 발견: v{}", update.version);

                            // 릴리즈 후 30분 이내면 CI 빌드가 아직 진행 중일 수 있으므로 건너뜀
                            let is_building = update.date.map_or(false, |date| {
                                let elapsed = chrono::Utc::now().timestamp() - date.unix_timestamp();
                                elapsed < 30 * 60
                            });
                            if is_building {
                                log::info!("[updater] 릴리즈 후 30분 미경과, 빌드 진행 중으로 판단하여 건너뜀");
                                return;
                            }

                            let version = update.version.clone();
                            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                            app_handle_update
                                .dialog()
                                .message(format!(
                                    "새로운 버전 v{}이 있습니다. 지금 설치하고 재시작하시겠습니까?",
                                    version
                                ))
                                .title("업데이트 가능")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "설치 및 재시작".into(),
                                    "나중에".into(),
                                ))
                                .show(move |confirmed| {
                                    let _ = tx.send(confirmed);
                                });
                            if rx.await.unwrap_or(false) {
                                app_handle_update
                                    .dialog()
                                    .message("업데이트를 다운로드하고 있습니다. 잠시만 기다려 주세요...")
                                    .title("업데이트 중")
                                    .show(|_| {});
                                match update.download_and_install(|_, _| {}, || {}).await {
                                    Ok(_) => {
                                        log::info!("[updater] 업데이트 설치 완료, 앱 재시작");
                                        app_handle_update.restart();
                                    }
                                    Err(e) => {
                                        log::error!("[updater] 업데이트 설치 실패: {}", e);
                                    }
                                }
                            }
                        }
                        Ok(None) => log::info!("[updater] 최신 버전입니다"),
                        Err(e) => log::debug!("[updater] 업데이트 확인 실패: {}", e),
                    }
                }
            });

            // 백그라운드 루프: 상태 계산, 트레이 갱신, 체커 주기적 리로드.
            let app_handle = app.handle().clone();
            scheduler::start_scheduler(app_handle, shared_state.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
