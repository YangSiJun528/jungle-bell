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

/// 앱 진입점.
///
/// Tauri 앱은 기본적으로 보이는 창이 없음 (tauri.conf.json에서 설정).
/// 시스템 트레이 아이콘 + 숨겨진 WebView로 출석 상태를 모니터링한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 로거 초기화. RUST_LOG 환경변수로 로그 수준 조절:
    //   RUST_LOG=debug cargo run   → 상세 로그 (HTML 덤프 포함)
    //   RUST_LOG=info  cargo run   → 일반 로그 (기본값)
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_target(true)
        .format_timestamp_secs()
        .init();

    let config = Config::load();
    let shared_state = Arc::new(Mutex::new(AppState::new(config)));

    tauri::Builder::default()
        // opener 플러그인: 시스템 브라우저로 URL 열기 (설정 페이지에서 사용)
        .plugin(tauri_plugin_opener::init())
        // AppState를 Tauri의 managed state로 등록.
        // 핸들러에서 `tauri::State<Arc<Mutex<AppState>>>`로 받아 사용.
        .manage(shared_state.clone())
        // JS에서 `window.__TAURI__.core.invoke()`로 호출할 수 있는 Tauri 커맨드 등록.
        .invoke_handler(tauri::generate_handler![checker::report_attendance_status,])
        // setup(): 앱 초기화 후 이벤트 루프 시작 전에 한 번 실행.
        .setup(move |app| {
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

            // 백그라운드 루프: 상태 계산, 트레이 갱신, 체커 주기적 리로드.
            let app_handle = app.handle().clone();
            scheduler::start_scheduler(app_handle, shared_state.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
