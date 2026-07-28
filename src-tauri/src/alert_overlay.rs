use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition};

use crate::tray::{self, TrayPanelAction};

pub const ALERT_OVERLAY_WINDOW_LABEL: &str = "alert-overlay";
pub const ALERT_OVERLAY_UPDATED_EVENT: &str = "alert-overlay-updated";

const ALERT_OVERLAY_BACKGROUND: tauri::webview::Color = tauri::webview::Color(0, 0, 0, 0);
const ALERT_OVERLAY_WIDTH: f64 = 400.0;
const ALERT_OVERLAY_MIN_HEIGHT: f64 = 151.0;
const ALERT_OVERLAY_MAX_HEIGHT: f64 = 520.0;
const ALERT_OVERLAY_HEADER_HEIGHT: f64 = 67.0;
const ALERT_OVERLAY_ITEM_HEIGHT: f64 = 84.0;
const ALERT_OVERLAY_MARGIN: f64 = 18.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlayPlacement {
    TopRight,
    BottomRight,
}

fn overlay_height(alert_count: usize) -> f64 {
    let count = alert_count.max(1) as f64;
    let desired = ALERT_OVERLAY_HEADER_HEIGHT + ALERT_OVERLAY_ITEM_HEIGHT * count;
    desired.clamp(ALERT_OVERLAY_MIN_HEIGHT, ALERT_OVERLAY_MAX_HEIGHT)
}

fn platform_placement() -> OverlayPlacement {
    if cfg!(target_os = "windows") {
        OverlayPlacement::BottomRight
    } else {
        OverlayPlacement::TopRight
    }
}

#[allow(clippy::too_many_arguments)]
fn calculate_overlay_position(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale_factor: f64,
    overlay_height: f64,
    placement: OverlayPlacement,
) -> PhysicalPosition<i32> {
    let width = (ALERT_OVERLAY_WIDTH * scale_factor).round() as i32;
    let height = (overlay_height * scale_factor).round() as i32;
    let margin = (ALERT_OVERLAY_MARGIN * scale_factor).round() as i32;
    let x = work_x + work_width as i32 - width - margin;
    let y = match placement {
        OverlayPlacement::TopRight => work_y + margin,
        OverlayPlacement::BottomRight => work_y + work_height as i32 - height - margin,
    };
    PhysicalPosition::new(x, y)
}

fn preserve_visible_position(
    current: PhysicalPosition<i32>,
    previous_height: u32,
    next_height: u32,
    placement: OverlayPlacement,
) -> PhysicalPosition<i32> {
    match placement {
        OverlayPlacement::TopRight => current,
        OverlayPlacement::BottomRight => {
            let y = i64::from(current.y) + i64::from(previous_height) - i64::from(next_height);
            PhysicalPosition::new(current.x, y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AlertOverlayAction {
    #[serde(rename = "openAttendance")]
    Attendance,
    #[serde(rename = "openLaundry")]
    Laundry,
    #[serde(rename = "openMeals")]
    Meals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertOverlayItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub action: AlertOverlayAction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertOverlaySnapshot {
    pub revision: u64,
    pub alerts: Vec<AlertOverlayItem>,
}

#[derive(Debug, Default)]
struct AlertOverlayQueue {
    revision: u64,
    next_id: u64,
    alerts: VecDeque<AlertOverlayItem>,
}

impl AlertOverlayQueue {
    fn snapshot(&self) -> AlertOverlaySnapshot {
        AlertOverlaySnapshot {
            revision: self.revision,
            alerts: self.alerts.iter().cloned().collect(),
        }
    }

    fn push(&mut self, title: String, body: String, action: AlertOverlayAction) -> AlertOverlaySnapshot {
        self.next_id = self.next_id.saturating_add(1);
        self.alerts.push_back(AlertOverlayItem {
            id: self.next_id.to_string(),
            title,
            body,
            action,
        });
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }

    fn action(&self, id: &str) -> Result<AlertOverlayAction, String> {
        self.alerts
            .iter()
            .find(|alert| alert.id == id)
            .map(|alert| alert.action)
            .ok_or_else(|| "열 알림을 찾지 못했습니다.".into())
    }

    fn dismiss(&mut self, id: &str) -> Result<AlertOverlaySnapshot, String> {
        let Some(index) = self.alerts.iter().position(|alert| alert.id == id) else {
            return Err("닫을 알림을 찾지 못했습니다.".into());
        };
        self.alerts.remove(index);
        self.revision = self.revision.saturating_add(1);
        Ok(self.snapshot())
    }
}

#[derive(Debug, Default)]
pub struct AlertOverlayService {
    queue: Mutex<AlertOverlayQueue>,
}

impl AlertOverlayService {
    pub fn enqueue(
        &self,
        app: &tauri::AppHandle,
        title: impl Into<String>,
        body: impl Into<String>,
        action: AlertOverlayAction,
    ) -> Result<AlertOverlaySnapshot, String> {
        let snapshot = self
            .queue
            .lock()
            .map_err(|_| "알림 창 큐 잠금이 손상되었습니다.".to_string())?
            .push(title.into(), body.into(), action);
        schedule_snapshot(app, snapshot.clone())?;
        Ok(snapshot)
    }

    pub fn snapshot(&self) -> Result<AlertOverlaySnapshot, String> {
        self.queue
            .lock()
            .map_err(|_| "알림 창 큐 잠금이 손상되었습니다.".to_string())
            .map(|queue| queue.snapshot())
    }

    pub fn dismiss(&self, app: &tauri::AppHandle, id: &str) -> Result<AlertOverlaySnapshot, String> {
        validate_alert_id(id)?;
        let snapshot = self
            .queue
            .lock()
            .map_err(|_| "알림 창 큐 잠금이 손상되었습니다.".to_string())?
            .dismiss(id)?;
        schedule_snapshot(app, snapshot.clone())?;
        Ok(snapshot)
    }

    pub fn activate(&self, app: &tauri::AppHandle, id: &str) -> Result<AlertOverlaySnapshot, String> {
        validate_alert_id(id)?;
        let action = self
            .queue
            .lock()
            .map_err(|_| "알림 창 큐 잠금이 손상되었습니다.".to_string())?
            .action(id)?;
        let tray_action = match action {
            AlertOverlayAction::Attendance => TrayPanelAction::OpenAttendance,
            AlertOverlayAction::Laundry => TrayPanelAction::OpenLaundry,
            AlertOverlayAction::Meals => TrayPanelAction::OpenMeals,
        };
        tray::run_tray_panel_action(app, tray_action)?;
        self.dismiss(app, id)
    }
}

fn validate_alert_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("잘못된 알림 ID입니다.".into());
    }
    Ok(())
}

fn schedule_snapshot(app: &tauri::AppHandle, snapshot: AlertOverlaySnapshot) -> Result<(), String> {
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || {
            if let Err(error) = apply_snapshot(&app, &snapshot) {
                log::error!("[alert-overlay] 표시 실패: {error}");
            }
        })
        .map_err(|error| format!("알림 창 표시 작업 예약 실패: {error}"))
}

fn apply_snapshot(app: &tauri::AppHandle, snapshot: &AlertOverlaySnapshot) -> Result<(), String> {
    if snapshot.alerts.is_empty() {
        if let Some(window) = app.get_webview_window(ALERT_OVERLAY_WINDOW_LABEL) {
            window.hide().map_err(|error| format!("알림 창 숨김 실패: {error}"))?;
        }
        return Ok(());
    }

    let height = overlay_height(snapshot.alerts.len());
    let window = match app.get_webview_window(ALERT_OVERLAY_WINDOW_LABEL) {
        Some(window) => window,
        None => tauri::WebviewWindowBuilder::new(
            app,
            ALERT_OVERLAY_WINDOW_LABEL,
            tauri::WebviewUrl::App("alert-overlay.html".into()),
        )
        .title("Jungle Bell 알림")
        .inner_size(ALERT_OVERLAY_WIDTH, height)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .visible(false)
        .focused(false)
        .accept_first_mouse(true)
        .background_color(ALERT_OVERLAY_BACKGROUND)
        .build()
        .map_err(|error| format!("알림 창 생성 실패: {error}"))?,
    };

    let previous_geometry = window
        .is_visible()
        .ok()
        .filter(|visible| *visible)
        .and_then(|_| Some((window.outer_position().ok()?, window.outer_size().ok()?)));
    window
        .set_size(LogicalSize::new(ALERT_OVERLAY_WIDTH, height))
        .map_err(|error| format!("알림 창 크기 변경 실패: {error}"))?;
    if let Some((position, previous_size)) = previous_geometry {
        let next_height = window
            .outer_size()
            .map(|size| size.height)
            .unwrap_or(previous_size.height);
        let position = preserve_visible_position(position, previous_size.height, next_height, platform_placement());
        window
            .set_position(position)
            .map_err(|error| format!("알림 창 이동 위치 유지 실패: {error}"))?;
    } else {
        position_window(app, &window, height);
    }
    window
        .emit(ALERT_OVERLAY_UPDATED_EVENT, snapshot)
        .map_err(|error| format!("알림 창 갱신 실패: {error}"))?;
    window.show().map_err(|error| format!("알림 창 표시 실패: {error}"))?;
    Ok(())
}

fn position_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow, height: f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let work_area = monitor.work_area();
    let position = calculate_overlay_position(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        monitor.scale_factor(),
        height,
        platform_placement(),
    );
    if let Err(error) = window.set_position(position) {
        log::debug!("[alert-overlay] 위치 설정 생략: {error}");
    }
}

pub fn ensure_overlay_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != ALERT_OVERLAY_WINDOW_LABEL {
        return Err("허용되지 않은 창입니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 알림은_닫기전까지_큐에_남고_닫으면_다음_알림이_표시된다() {
        let mut queue = AlertOverlayQueue::default();
        let first = queue.push(
            "출석 알림".into(),
            "학습 시작을 확인해 주세요.".into(),
            AlertOverlayAction::Attendance,
        );
        let first_id = first.alerts[0].id.clone();
        let second = queue.push(
            "세탁 알림".into(),
            "세탁이 끝났습니다.".into(),
            AlertOverlayAction::Laundry,
        );

        assert_eq!(second.alerts.len(), 2);
        assert_eq!(second.alerts[0].title, "출석 알림");
        assert_eq!(second.alerts[1].action, AlertOverlayAction::Laundry);

        let after_dismiss = queue.dismiss(&first_id).unwrap();
        assert_eq!(after_dismiss.alerts.len(), 1);
        assert_eq!(after_dismiss.alerts[0].title, "세탁 알림");
        assert!(after_dismiss.revision > second.revision);
    }

    #[test]
    fn 같은_화면으로_이동하는_후속_알림도_각각_목록에_남는다() {
        let mut queue = AlertOverlayQueue::default();
        queue.push(
            "세탁 종료 5분 전".into(),
            "3번 세탁기가 곧 끝납니다.".into(),
            AlertOverlayAction::Laundry,
        );
        let snapshot = queue.push(
            "세탁 완료".into(),
            "3번 세탁기가 끝났습니다.".into(),
            AlertOverlayAction::Laundry,
        );

        assert_eq!(snapshot.alerts.len(), 2);
        assert_ne!(snapshot.alerts[0].id, snapshot.alerts[1].id);
        assert!(snapshot
            .alerts
            .iter()
            .all(|alert| alert.action == AlertOverlayAction::Laundry));
    }

    #[test]
    fn 알림_id는_숫자만_허용한다() {
        assert!(validate_alert_id("42").is_ok());
        assert!(validate_alert_id("").is_err());
        assert!(validate_alert_id("1\n2").is_err());
        assert!(validate_alert_id("alert-1").is_err());
    }

    #[test]
    fn 알림_이동_대상은_프런트엔드_액션명으로_직렬화된다() {
        assert_eq!(
            serde_json::to_value(AlertOverlayAction::Attendance).unwrap(),
            "openAttendance"
        );
        assert_eq!(
            serde_json::to_value(AlertOverlayAction::Laundry).unwrap(),
            "openLaundry"
        );
        assert_eq!(serde_json::to_value(AlertOverlayAction::Meals).unwrap(), "openMeals");
    }

    #[test]
    fn 알림창의_네이티브_배경은_완전히_투명하다() {
        assert_eq!(ALERT_OVERLAY_BACKGROUND, tauri::webview::Color(0, 0, 0, 0));
    }

    #[test]
    fn 알림_수에_따라_창_높이가_늘어나고_최대_높이를_넘지_않는다() {
        assert_eq!(overlay_height(1), 151.0);
        assert_eq!(overlay_height(3), 319.0);
        assert_eq!(overlay_height(20), 520.0);
    }

    #[test]
    fn macos는_우측_상단_windows는_작업표시줄_위_우측_하단에_배치한다() {
        let top_right = calculate_overlay_position(10, 30, 1_440, 870, 1.0, 370.0, OverlayPlacement::TopRight);
        let bottom_right = calculate_overlay_position(10, 30, 1_440, 870, 1.0, 370.0, OverlayPlacement::BottomRight);

        assert_eq!(top_right, PhysicalPosition::new(1_032, 48));
        assert_eq!(bottom_right, PhysicalPosition::new(1_032, 512));
    }

    #[test]
    fn 사용자가_옮긴_창은_새_알림으로_높이가_바뀌어도_현재_기준점을_유지한다() {
        let current = PhysicalPosition::new(320, 240);
        assert_eq!(
            preserve_visible_position(current, 151, 319, OverlayPlacement::TopRight),
            current
        );
        assert_eq!(
            preserve_visible_position(current, 151, 319, OverlayPlacement::BottomRight),
            PhysicalPosition::new(320, 72)
        );
    }
}
