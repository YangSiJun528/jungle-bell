//! 시스템 트레이 모듈 — 아이콘, 메뉴, 툴팁, 메뉴 이벤트 처리.
//!
//! 트레이 아이콘은 현재 상태에 따라 색상이 변경됨:
//!   - 흰색 (기본): Idle, Studying, Complete
//!   - 오렌지 (경고): 로그인 필요
//!   - 빨간색 (긴급): NeedStart, StartOverdue, NeedEnd

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::state::{AppState, DailyPhase};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, WebviewWindow,
};

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";

/// 출석 페이지 닫힌 후 로그인 재시도 윈도우 (초). 3분간 빠르게 재확인.
const LOGIN_RETRY_WINDOW_SECS: u64 = 180;

// 트레이 아이콘 — 컴파일 시 include_bytes!로 바이너리에 포함
const ICON_DEFAULT: &[u8] = include_bytes!("../icons/tray-white.png");
const ICON_ALERT: &[u8] = include_bytes!("../icons/tray-red.png");
const ICON_WARNING: &[u8] = include_bytes!("../icons/tray-orange.png");

/// 상태 메뉴 아이템 참조 보관용. 텍스트 동적 갱신에 사용.
/// Tauri managed state로 저장: `Arc<TokioMutex<TrayState>>`.
pub struct TrayState {
    pub status_item: MenuItem<tauri::Wry>,
    pub version_item: MenuItem<tauri::Wry>,
}

/// 상태에 따라 트레이 아이콘 선택.
/// - 오렌지 (경고): 로그인 필요
/// - 빨간색 (긴급): 출석 액션 필요
/// - 흰색 (기본): 대기/학습 중/완료
fn icon_for_phase(phase: DailyPhase, needs_login: bool) -> Image<'static> {
    let bytes = if needs_login {
        ICON_WARNING
    } else {
        match phase {
            DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd => ICON_ALERT,
            _ => ICON_DEFAULT,
        }
    };
    Image::from_bytes(bytes).expect("invalid icon PNG")
}

/// 트레이 메뉴에 표시할 상태 텍스트 생성.
fn build_status_text(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> String {
    if needs_login {
        return "⚠️ 로그인 필요".to_string();
    }

    let mins = remaining.map(|s| (s + 59) / 60);

    /// 분 단위 잔여시간을 "Xh Ym" 또는 "X분" 형식으로 포매팅.
    fn fmt_time(m: i64) -> String {
        let hours = m / 60;
        let rest = m % 60;
        if hours > 0 {
            format!("{}h {}m", hours, rest)
        } else {
            format!("{}분", m)
        }
    }

    match phase {
        DailyPhase::Idle => "대기 중".to_string(),
        DailyPhase::NeedStart => match mins {
            Some(m) => format!("학습 시작 가능 ({} 남음)", fmt_time(m)),
            None => "학습 시작 가능".to_string(),
        },
        DailyPhase::StartOverdue => match mins {
            Some(m) if m > 0 => format!("지각 임박 ({}분 남음)", m),
            _ => "학습 시작 지각!".to_string(),
        },
        DailyPhase::Studying => match mins {
            Some(m) => format!("학습 중 (종료 가능까지 {})", fmt_time(m)),
            None => "학습 중".to_string(),
        },
        DailyPhase::NeedEnd => match mins {
            Some(m) => format!("학습 종료 가능 ({} 남음)", fmt_time(m)),
            None => "학습 종료 가능".to_string(),
        },
        DailyPhase::Complete => "오늘 출석 완료".to_string(),
    }
}

/// 툴팁 텍스트 생성 (트레이 아이콘에 마우스 올릴 때 표시).
fn build_tooltip(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> String {
    let status = build_status_text(phase, remaining, needs_login);
    format!("Jungle Bell - {}", status)
}

fn focus_window(window: &WebviewWindow<tauri::Wry>) {
    let _ = window.show();
    let _ = window.unminimize();

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            ns_app.activate();
        }
    }

    let _ = window.set_focus();
}

fn activate_login_retry_window(app_handle: &tauri::AppHandle) {
    let state: tauri::State<Arc<TokioMutex<AppState>>> = app_handle.state();
    if let Ok(mut s) = state.try_lock() {
        s.login_retry_until = Some(chrono::Utc::now() + chrono::Duration::seconds(LOGIN_RETRY_WINDOW_SECS as i64));
    };
}

fn reload_checker(app_handle: &tauri::AppHandle) {
    if let Some(checker) = app_handle.get_webview_window("checker") {
        let _ = checker.navigate(ATTENDANCE_URL.parse().unwrap());
    }
}

fn build_attendance_window(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    if let Ok(window) = tauri::WebviewWindowBuilder::new(
        app,
        "attendance",
        tauri::WebviewUrl::External(ATTENDANCE_URL.parse().unwrap()),
    )
    .title("Jungle Compass")
    .inner_size(660.0, 700.0)
    .resizable(true)
    .focused(true)
    .build()
    {
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                log::info!("[tray] attendance page closed, reloading checker + activating login retry");
                reload_checker(&app_handle);
                activate_login_retry_window(&app_handle);
            }
        });
    }
}

fn open_attendance_window(app: &tauri::AppHandle) {
    log::info!("[tray] attendance window opened");
    crate::analytics::track_attendance_page_opened();

    if let Some(window) = app.get_webview_window("attendance") {
        focus_window(&window);
    } else {
        build_attendance_window(app);
    }
}

fn build_settings_window(app: &tauri::AppHandle) {
    let _ = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("index.html".into()))
        .title("설정")
        .inner_size(380.0, 520.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .focused(true)
        .build();
}

fn open_settings_window(app: &tauri::AppHandle) {
    log::info!("[tray] settings window opened");
    crate::analytics::track_settings_opened();

    if let Some(window) = app.get_webview_window("settings") {
        focus_window(&window);
    } else {
        build_settings_window(app);
    }
}

fn handle_menu_event(app: &tauri::AppHandle, event_id: &str) {
    match event_id {
        "open_page" => open_attendance_window(app),
        "settings" => open_settings_window(app),
        "version" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::updater::prompt_and_install_update(app, false).await;
            });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// 시스템 트레이 생성: 아이콘, 메뉴, 이벤트 핸들러 설정.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let status_item = MenuItemBuilder::with_id("status", "로딩 중...")
        .enabled(false)
        .build(app)?;

    let open_page = MenuItemBuilder::with_id("open_page", "출석 페이지 열기").build(app)?;

    let settings = MenuItemBuilder::with_id("settings", "설정...").build(app)?;

    let current_version = app.package_info().version.to_string();
    let version_item = MenuItemBuilder::with_id("version", format!("v{}", current_version))
        .enabled(false)
        .build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "종료").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&open_page)
        .item(&settings)
        .separator()
        .item(&version_item)
        .item(&quit)
        .build()?;

    // 상태 아이템을 Tauri managed state에 저장해서 update_tray()에서 접근 가능하게 함.
    let tray_state = Arc::new(TokioMutex::new(TrayState {
        status_item: status_item.clone(),
        version_item: version_item.clone(),
    }));
    app.manage(tray_state);

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(ICON_WARNING).expect("invalid icon PNG"))
        .tooltip("Jungle Bell")
        .menu(&menu)
        .on_menu_event(move |app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- build_status_text ---

    #[test]
    fn 로그인_필요시_로그인_메시지를_표시한다() {
        assert_eq!(build_status_text(DailyPhase::Idle, None, true), "⚠️ 로그인 필요");
    }

    #[test]
    fn 로그인_필요시_phase와_무관하게_로그인_메시지를_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedStart, Some(3600), true),
            "⚠️ 로그인 필요"
        );
    }

    #[test]
    fn 대기중_상태를_표시한다() {
        assert_eq!(build_status_text(DailyPhase::Idle, None, false), "대기 중");
    }

    #[test]
    fn 학습시작_시간_분_형식을_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedStart, Some(5400), false),
            "학습 시작 가능 (1h 30m 남음)"
        );
    }

    #[test]
    fn 학습시작_분만_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedStart, Some(1800), false),
            "학습 시작 가능 (30분 남음)"
        );
    }

    #[test]
    fn 학습시작_잔여시간_없으면_시간_생략한다() {
        assert_eq!(build_status_text(DailyPhase::NeedStart, None, false), "학습 시작 가능");
    }

    #[test]
    fn 학습시작_정확히_1시간이면_시간_분_형식을_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedStart, Some(3600), false),
            "학습 시작 가능 (1h 0m 남음)"
        );
    }

    #[test]
    fn 학습시작_59초면_1분으로_올림_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedStart, Some(59), false),
            "학습 시작 가능 (1분 남음)"
        );
    }

    #[test]
    fn 지각임박_잔여분을_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::StartOverdue, Some(300), false),
            "지각 임박 (5분 남음)"
        );
    }

    #[test]
    fn 지각_잔여0이면_지각_메시지를_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::StartOverdue, Some(0), false),
            "학습 시작 지각!"
        );
    }

    #[test]
    fn 지각_잔여없으면_지각_메시지를_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::StartOverdue, None, false),
            "학습 시작 지각!"
        );
    }

    #[test]
    fn 학습중_시간_분_형식을_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::Studying, Some(5400), false),
            "학습 중 (종료 가능까지 1h 30m)"
        );
    }

    #[test]
    fn 학습중_분만_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::Studying, Some(1800), false),
            "학습 중 (종료 가능까지 30분)"
        );
    }

    #[test]
    fn 학습중_잔여시간_없으면_시간_생략한다() {
        assert_eq!(build_status_text(DailyPhase::Studying, None, false), "학습 중");
    }

    #[test]
    fn 종료가능_시간_분_형식을_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedEnd, Some(5400), false),
            "학습 종료 가능 (1h 30m 남음)"
        );
    }

    #[test]
    fn 종료가능_분만_표시한다() {
        assert_eq!(
            build_status_text(DailyPhase::NeedEnd, Some(1800), false),
            "학습 종료 가능 (30분 남음)"
        );
    }

    #[test]
    fn 종료가능_잔여시간_없으면_시간_생략한다() {
        assert_eq!(build_status_text(DailyPhase::NeedEnd, None, false), "학습 종료 가능");
    }

    #[test]
    fn 출석완료_상태를_표시한다() {
        assert_eq!(build_status_text(DailyPhase::Complete, None, false), "오늘 출석 완료");
    }

    // --- build_tooltip ---

    #[test]
    fn 툴팁_대기중을_표시한다() {
        assert_eq!(build_tooltip(DailyPhase::Idle, None, false), "Jungle Bell - 대기 중");
    }

    #[test]
    fn 툴팁_학습시작_잔여시간을_표시한다() {
        assert_eq!(
            build_tooltip(DailyPhase::NeedStart, Some(1800), false),
            "Jungle Bell - 학습 시작 가능 (30분 남음)"
        );
    }

    #[test]
    fn 툴팁_로그인_필요를_표시한다() {
        assert_eq!(
            build_tooltip(DailyPhase::Idle, None, true),
            "Jungle Bell - ⚠️ 로그인 필요"
        );
    }

    #[test]
    fn 툴팁_출석완료를_표시한다() {
        assert_eq!(
            build_tooltip(DailyPhase::Complete, None, false),
            "Jungle Bell - 오늘 출석 완료"
        );
    }
}

/// 트레이 버전 메뉴 아이템 갱신.
///
/// - `pending_update` = Some(version): "v{current} (업데이트 가능)" — 클릭 가능
/// - `pending_update` = None: "v{current}" — 비활성(회색)
pub fn update_tray_version(app: &tauri::AppHandle, pending_update: Option<String>) {
    let current_version = app.package_info().version.to_string();
    let (text, enabled) = if pending_update.is_some() {
        (format!("v{} (업데이트 가능)", current_version), true)
    } else {
        (format!("v{}", current_version), false)
    };
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    if let Ok(ts) = tray_state.try_lock() {
        let _ = ts.version_item.set_text(text);
        let _ = ts.version_item.set_enabled(enabled);
    };
}

/// 트레이 아이콘, 툴팁, 상태 메뉴 텍스트 갱신.
/// 스케줄러(주기적)와 체커(보고 시) 양쪽에서 호출됨.
pub fn update_tray(app: &tauri::AppHandle, phase: DailyPhase, remaining: Option<i64>, needs_login: bool) {
    let status_text = build_status_text(phase, remaining, needs_login);
    let tooltip = build_tooltip(phase, remaining, needs_login);

    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(icon_for_phase(phase, needs_login)));
        let _ = tray.set_tooltip(Some(&tooltip));
    }

    // 상태 메뉴 아이템 텍스트 갱신.
    // try_lock 사용 — 락이 잡혀 있으면 이번 갱신은 건너뜀.
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    if let Ok(ts) = tray_state.try_lock() {
        let _ = ts.status_item.set_text(status_text);
    };
}
