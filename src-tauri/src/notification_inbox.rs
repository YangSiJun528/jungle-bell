use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::tray::{self, TrayPanelAction};

pub const NOTIFICATION_INBOX_UPDATED_EVENT: &str = "notification-inbox-updated";
pub const MAX_NOTIFICATION_ITEMS: usize = 100;

const NOTIFICATION_INBOX_VERSION: u32 = 1;
#[cfg(target_os = "windows")]
const WINDOWS_BADGE_WINDOW_LABELS: [&str; 5] = ["attendance", "settings", "onboarding", "campus", "image-viewer"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotificationAction {
    #[serde(rename = "openAttendance")]
    Attendance,
    #[serde(rename = "openLaundry")]
    Laundry,
    #[serde(rename = "openMeals")]
    Meals,
}

impl NotificationAction {
    pub(crate) fn tray_action(self) -> TrayPanelAction {
        match self {
            Self::Attendance => TrayPanelAction::OpenAttendance,
            Self::Laundry => TrayPanelAction::OpenLaundry,
            Self::Meals => TrayPanelAction::OpenMeals,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInboxItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub action: Option<NotificationAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredNotification {
    item: NotificationInboxItem,
    key: String,
    dedupe_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInboxSnapshot {
    pub revision: u64,
    pub unread_count: usize,
    pub items: Vec<NotificationInboxItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct NotificationInboxStore {
    version: u32,
    revision: u64,
    next_id: u64,
    items: VecDeque<StoredNotification>,
}

impl Default for NotificationInboxStore {
    fn default() -> Self {
        Self {
            version: NOTIFICATION_INBOX_VERSION,
            revision: 0,
            next_id: 0,
            items: VecDeque::new(),
        }
    }
}

impl NotificationInboxStore {
    fn snapshot(&self) -> NotificationInboxSnapshot {
        let items: Vec<_> = self.items.iter().map(|stored| stored.item.clone()).collect();
        NotificationInboxSnapshot {
            revision: self.revision,
            unread_count: items.iter().filter(|item| item.read_at.is_none()).count(),
            items,
        }
    }

    fn push(
        &mut self,
        key: String,
        title: String,
        body: String,
        action: Option<NotificationAction>,
        dedupe_key: Option<String>,
        created_at: i64,
    ) -> NotificationInboxSnapshot {
        if let Some(position) = dedupe_key.as_deref().and_then(|dedupe_key| {
            self.items
                .iter()
                .position(|stored| stored.dedupe_key.as_deref() == Some(dedupe_key))
        }) {
            if let Some(mut existing) = self.items.remove(position) {
                existing.item.title = title;
                existing.item.body = body;
                existing.item.action = action;
                existing.item.created_at = created_at;
                existing.item.read_at = None;
                existing.key = key;
                self.items.push_front(existing);
            }
        } else {
            self.next_id = self.next_id.saturating_add(1);
            self.items.push_front(StoredNotification {
                item: NotificationInboxItem {
                    id: self.next_id.to_string(),
                    title,
                    body,
                    created_at,
                    read_at: None,
                    action,
                },
                key,
                dedupe_key,
            });
        }

        self.items.truncate(MAX_NOTIFICATION_ITEMS);
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }

    fn mark_read(&mut self, id: &str, read_at: i64) -> Result<Option<NotificationAction>, String> {
        validate_notification_id(id)?;
        let item = self
            .items
            .iter_mut()
            .find(|stored| stored.item.id == id)
            .ok_or_else(|| "알림을 찾지 못했습니다.".to_string())?;
        if item.item.read_at.is_none() {
            item.item.read_at = Some(read_at);
            self.revision = self.revision.saturating_add(1);
        }
        Ok(item.item.action)
    }

    fn load_from(path: &Path) -> Result<Self, String> {
        let data = match fs::read(path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(format!("알림함({}) 읽기 실패: {error}", path.display())),
        };
        let mut store: Self =
            serde_json::from_slice(&data).map_err(|error| format!("알림함({}) 파싱 실패: {error}", path.display()))?;
        store.version = NOTIFICATION_INBOX_VERSION;
        store.items.truncate(MAX_NOTIFICATION_ITEMS);
        store.next_id = store
            .items
            .iter()
            .filter_map(|stored| stored.item.id.parse::<u64>().ok())
            .fold(store.next_id, u64::max);
        Ok(store)
    }

    fn save_to(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "알림함 상위 디렉토리가 없습니다.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("알림함 디렉토리({}) 생성 실패: {error}", parent.display()))?;
        let data = serde_json::to_vec_pretty(self).map_err(|error| format!("알림함 직렬화 실패: {error}"))?;
        crate::config::write_file_atomically(path, &data)
            .map_err(|error| format!("알림함({}) 저장 실패: {error}", path.display()))
    }
}

pub struct NotificationInboxService {
    path: Option<PathBuf>,
    store: Mutex<NotificationInboxStore>,
}

impl NotificationInboxService {
    pub fn load() -> Self {
        let path = notification_inbox_path();
        let store = path
            .as_deref()
            .map(NotificationInboxStore::load_from)
            .transpose()
            .unwrap_or_else(|error| {
                log::error!("[notification-inbox] {error}; 빈 알림함으로 시작합니다");
                None
            })
            .unwrap_or_default();
        Self {
            path,
            store: Mutex::new(store),
        }
    }

    pub fn initialize(&self, app: &tauri::AppHandle) {
        match self.snapshot() {
            Ok(snapshot) => apply_unread_badge(app, snapshot.unread_count),
            Err(error) => log::error!("[notification-inbox] 초기 배지 적용 실패: {error}"),
        }
    }

    pub fn record(
        &self,
        app: &tauri::AppHandle,
        key: &str,
        title: &str,
        body: &str,
        action: Option<NotificationAction>,
        dedupe_key: Option<&str>,
    ) -> Result<(String, NotificationInboxSnapshot), String> {
        let path = self
            .path
            .as_deref()
            .ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        let mut store = self
            .store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())?;
        let mut next = store.clone();
        let snapshot = next.push(
            key.to_owned(),
            title.to_owned(),
            body.to_owned(),
            action,
            dedupe_key.map(str::to_owned),
            Utc::now().timestamp_millis(),
        );
        let id = snapshot
            .items
            .first()
            .map(|item| item.id.clone())
            .ok_or_else(|| "저장된 알림 ID를 확인할 수 없습니다.".to_string())?;
        next.save_to(path)?;
        *store = next;
        drop(store);
        publish_snapshot(app, &snapshot);
        Ok((id, snapshot))
    }

    pub fn snapshot(&self) -> Result<NotificationInboxSnapshot, String> {
        self.store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())
            .map(|store| store.snapshot())
    }

    pub fn activate(&self, app: &tauri::AppHandle, id: &str) -> Result<NotificationInboxSnapshot, String> {
        let path = self
            .path
            .as_deref()
            .ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        let mut store = self
            .store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())?;
        let mut next = store.clone();
        let previous_revision = next.revision;
        let action = next.mark_read(id, Utc::now().timestamp_millis())?;
        if next.revision != previous_revision {
            next.save_to(path)?;
            *store = next;
        }
        let snapshot = store.snapshot();
        drop(store);

        if snapshot.revision != previous_revision {
            publish_snapshot(app, &snapshot);
        }
        if let Some(action) = action {
            tray::run_tray_panel_action(app, action.tray_action())?;
        }
        Ok(snapshot)
    }
}

pub fn ensure_tray_panel_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "tray-panel" {
        return Err("허용되지 않은 창입니다.".into());
    }
    Ok(())
}

pub fn sync_badge_for_window(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        let service = window.app_handle().state::<std::sync::Arc<NotificationInboxService>>();
        match service.snapshot() {
            Ok(snapshot) => {
                let icon = (snapshot.unread_count > 0).then(unread_overlay_icon);
                if let Err(error) = window.set_overlay_icon(icon) {
                    log::debug!("[notification-inbox] Windows 창 배지 적용 생략: {error}");
                }
            }
            Err(error) => log::debug!("[notification-inbox] Windows 창 배지 상태 확인 생략: {error}"),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

fn notification_inbox_path() -> Option<PathBuf> {
    crate::config::config_path().map(|path| path.with_file_name("notifications.json"))
}

fn validate_notification_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("잘못된 알림 ID입니다.".into());
    }
    Ok(())
}

fn publish_snapshot(app: &tauri::AppHandle, snapshot: &NotificationInboxSnapshot) {
    if let Err(error) = app.emit_to("tray-panel", NOTIFICATION_INBOX_UPDATED_EVENT, snapshot) {
        log::debug!("[notification-inbox] snapshot emit skipped: {error}");
    }
    apply_unread_badge(app, snapshot.unread_count);
}

fn apply_unread_badge(app: &tauri::AppHandle, unread_count: usize) {
    let app = app.clone();
    if let Err(error) = app.clone().run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window("tray-panel") {
            let label = (unread_count > 0).then(|| "•".to_string());
            if let Err(error) = window.set_badge_label(label) {
                log::debug!("[notification-inbox] macOS Dock 배지 적용 생략: {error}");
            }
        }

        #[cfg(target_os = "windows")]
        {
            let icon = (unread_count > 0).then(unread_overlay_icon);
            for label in WINDOWS_BADGE_WINDOW_LABELS {
                if let Some(window) = app.get_webview_window(label) {
                    if let Err(error) = window.set_overlay_icon(icon.clone()) {
                        log::debug!("[notification-inbox] Windows 작업표시줄 배지 적용 생략({label}): {error}");
                    }
                }
            }
        }
    }) {
        log::debug!("[notification-inbox] 배지 적용 예약 생략: {error}");
    }
}

#[cfg(target_os = "windows")]
fn unread_overlay_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    const CENTER: i32 = 16;
    const OUTER_RADIUS_SQUARED: i32 = 12 * 12;
    const INNER_RADIUS_SQUARED: i32 = 10 * 10;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE as i32 {
        for x in 0..SIZE as i32 {
            let distance = (x - CENTER).pow(2) + (y - CENTER).pow(2);
            let color = if distance <= INNER_RADIUS_SQUARED {
                [229, 57, 53, 255]
            } else if distance <= OUTER_RADIUS_SQUARED {
                [255, 255, 255, 255]
            } else {
                [0, 0, 0, 0]
            };
            let offset = ((y as u32 * SIZE + x as u32) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(
        store: &mut NotificationInboxStore,
        title: &str,
        action: Option<NotificationAction>,
        dedupe_key: Option<&str>,
        created_at: i64,
    ) -> NotificationInboxSnapshot {
        store.push(
            "test.key".into(),
            title.into(),
            "알림 내용".into(),
            action,
            dedupe_key.map(str::to_owned),
            created_at,
        )
    }

    #[test]
    fn 새_알림은_최신순으로_쌓이고_미읽음_수에_포함된다() {
        let mut store = NotificationInboxStore::default();
        push(&mut store, "첫 알림", Some(NotificationAction::Attendance), None, 1_000);
        let snapshot = push(
            &mut store,
            "두 번째 알림",
            Some(NotificationAction::Laundry),
            None,
            2_000,
        );

        assert_eq!(snapshot.unread_count, 2);
        assert_eq!(snapshot.items[0].title, "두 번째 알림");
        assert_eq!(snapshot.items[1].title, "첫 알림");
        assert!(snapshot.items.iter().all(|item| item.read_at.is_none()));
    }

    #[test]
    fn 같은_dedupe_key는_기존_id를_갱신하고_다시_미읽음으로_만든다() {
        let mut store = NotificationInboxStore::default();
        let first = push(
            &mut store,
            "출석 알림",
            Some(NotificationAction::Attendance),
            Some("attendance"),
            1_000,
        );
        let id = first.items[0].id.clone();
        store.mark_read(&id, 1_500).unwrap();

        let updated = push(
            &mut store,
            "출석 재알림",
            Some(NotificationAction::Attendance),
            Some("attendance"),
            2_000,
        );

        assert_eq!(updated.items.len(), 1);
        assert_eq!(updated.items[0].id, id);
        assert_eq!(updated.items[0].title, "출석 재알림");
        assert_eq!(updated.items[0].read_at, None);
        assert_eq!(updated.unread_count, 1);
    }

    #[test]
    fn 알림_활성화는_해당_항목만_읽음으로_바꾸고_이동_대상을_반환한다() {
        let mut store = NotificationInboxStore::default();
        let first = push(&mut store, "출석", Some(NotificationAction::Attendance), None, 1_000);
        let first_id = first.items[0].id.clone();
        push(&mut store, "식단", Some(NotificationAction::Meals), None, 2_000);

        let action = store.mark_read(&first_id, 3_000).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(action, Some(NotificationAction::Attendance));
        assert_eq!(snapshot.unread_count, 1);
        assert_eq!(
            snapshot.items.iter().find(|item| item.id == first_id).unwrap().read_at,
            Some(3_000)
        );
    }

    #[test]
    fn 알림함은_최신_백개만_보존한다() {
        let mut store = NotificationInboxStore::default();
        for index in 0..=MAX_NOTIFICATION_ITEMS {
            push(&mut store, &format!("알림 {index}"), None, None, index as i64 + 1);
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.items.len(), MAX_NOTIFICATION_ITEMS);
        assert_eq!(snapshot.items[0].title, format!("알림 {MAX_NOTIFICATION_ITEMS}"));
        assert_eq!(snapshot.items.last().unwrap().title, "알림 1");
    }

    #[test]
    fn 저장한_알림함은_재시작후에도_id와_읽음_상태를_복구한다() {
        let temp_dir =
            std::env::temp_dir().join(format!("jungle-bell-notification-inbox-{}-{}", std::process::id(), 1));
        let path = temp_dir.join("notifications.json");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let mut store = NotificationInboxStore::default();
        let snapshot = push(&mut store, "세탁 완료", Some(NotificationAction::Laundry), None, 1_000);
        let id = snapshot.items[0].id.clone();
        store.mark_read(&id, 2_000).unwrap();
        store.save_to(&path).unwrap();

        let restored = NotificationInboxStore::load_from(&path).unwrap();
        assert_eq!(restored.snapshot(), store.snapshot());

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn 알림_이동_대상은_프런트엔드_이름으로_직렬화된다() {
        assert_eq!(
            serde_json::to_value(NotificationAction::Attendance).unwrap(),
            "openAttendance"
        );
        assert_eq!(
            serde_json::to_value(NotificationAction::Laundry).unwrap(),
            "openLaundry"
        );
        assert_eq!(serde_json::to_value(NotificationAction::Meals).unwrap(), "openMeals");
    }
}
