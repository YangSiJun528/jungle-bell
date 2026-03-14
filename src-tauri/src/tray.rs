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
    Manager,
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

    let mins = remaining.map(|s| s / 60);

    match phase {
        DailyPhase::Idle => "대기 중".to_string(),
        DailyPhase::NeedStart => {
            if let Some(m) = mins {
                format!("학습 시작 가능 ({}분 남음)", m)
            } else {
                "학습 시작 가능".to_string()
            }
        }
        DailyPhase::StartOverdue => "학습 시작 지각!".to_string(),
        DailyPhase::Studying => {
            if let Some(m) = mins {
                let hours = m / 60;
                let rest_mins = m % 60;
                if hours > 0 {
                    format!("학습 중 (종료 가능까지 {}h {}m)", hours, rest_mins)
                } else {
                    format!("학습 중 (종료 가능까지 {}분)", m)
                }
            } else {
                "학습 중".to_string()
            }
        }
        DailyPhase::NeedEnd => {
            if let Some(m) = mins {
                let hours = m / 60;
                let rest_mins = m % 60;
                if hours > 0 {
                    format!("학습 종료 가능 ({}h {}m 남음)", hours, rest_mins)
                } else {
                    format!("학습 종료 가능 ({}분 남음)", m)
                }
            } else {
                "학습 종료 가능".to_string()
            }
        }
        DailyPhase::Complete => "오늘 출석 완료".to_string(),
    }
}

/// 툴팁 텍스트 생성 (트레이 아이콘에 마우스 올릴 때 표시).
fn build_tooltip(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> String {
    let status = build_status_text(phase, remaining, needs_login);
    format!("Jungle Bell - {}", status)
}

/// 시스템 트레이 생성: 아이콘, 메뉴, 이벤트 핸들러 설정.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let status_item = MenuItemBuilder::with_id("status", "로딩 중...")
        .enabled(false)
        .build(app)?;

    let open_page = MenuItemBuilder::with_id("open_page", "출석 페이지 열기").build(app)?;

    let settings = MenuItemBuilder::with_id("settings", "설정...").build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "종료").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&open_page)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;

    // 상태 아이템을 Tauri managed state에 저장해서 update_tray()에서 접근 가능하게 함.
    let tray_state = Arc::new(TokioMutex::new(TrayState {
        status_item: status_item.clone(),
    }));
    app.manage(tray_state);

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(ICON_WARNING).expect("invalid icon PNG"))
        .tooltip("Jungle Bell")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open_page" => {
                log::info!("[tray] attendance window opened");
                // 기존 출석 창이 있으면 재사용, 없으면 새로 생성.
                if let Some(window) = app.get_webview_window("attendance") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
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
                        // 출석 창이 닫히면 체커를 리로드하고
                        // 로그인 재시도 윈도우를 활성화 (3분간 로그인 상태 재확인).
                        window.on_window_event(move |event| {
                            if let tauri::WindowEvent::Destroyed = event {
                                log::info!("[tray] attendance page closed, reloading checker + activating login retry");
                                if let Some(checker) = app_handle.get_webview_window("checker") {
                                    let _ =
                                        checker.navigate("https://jungle-lms.krafton.com/check-in".parse().unwrap());
                                }
                                // 로그인 재시도 윈도우: 3분간 활성
                                {
                                    let state: tauri::State<Arc<TokioMutex<AppState>>> = app_handle.state();
                                    if let Ok(mut s) = state.try_lock() {
                                        s.login_retry_until = Some(
                                            tokio::time::Instant::now() + std::time::Duration::from_secs(LOGIN_RETRY_WINDOW_SECS)
                                        );
                                    };
                                }
                            }
                        });
                    }
                }
            }
            "settings" => {
                log::info!("[tray] settings window opened");
                // 기존 설정 창이 있으면 재사용, 없으면 새로 생성.
                // 설정 창은 src/index.html (프론트엔드)을 로드.
                if let Some(window) = app.get_webview_window("settings") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ =
                        tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("index.html".into()))
                            .title("설정")
                            .inner_size(400.0, 420.0)
                            .resizable(false)
                            .minimizable(false)
                            .maximizable(false)
                            .focused(true)
                            .build();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
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
