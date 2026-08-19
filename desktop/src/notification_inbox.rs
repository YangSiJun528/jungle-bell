use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::Emitter;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;

use crate::tray::{self, DashboardRoute};

pub const NOTIFICATION_INBOX_UPDATED_EVENT: &str = "notification-inbox-updated";
pub const MAX_NOTIFICATION_ITEMS: usize = 100;

const NOTIFICATION_INBOX_VERSION: u32 = 1;
#[cfg(target_os = "windows")]
const WINDOWS_BADGE_WINDOW_LABELS: [&str; 2] = ["dashboard", "checker"];

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
    pub(crate) fn dashboard_route(self) -> DashboardRoute {
        match self {
            Self::Attendance => DashboardRoute::Attendance,
            Self::Laundry => DashboardRoute::Laundry,
            Self::Meals => DashboardRoute::Meals,
        }
    }
}

fn activation_dashboard_route(action: Option<NotificationAction>) -> DashboardRoute {
    action.map_or(DashboardRoute::Notifications, NotificationAction::dashboard_route)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationInboxItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub read_at: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub action: Option<NotificationAction>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredNotification {
    item: NotificationInboxItem,
    key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInboxSnapshot {
    pub revision: u64,
    pub unread_count: usize,
    pub items: Vec<NotificationInboxItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
        repeat_after_ms: Option<i64>,
        created_at: i64,
    ) -> (String, NotificationInboxSnapshot, bool) {
        if let Some(existing) = self.items.iter().find(|stored| stored.key == key) {
            let should_reuse =
                repeat_after_ms.is_none_or(|interval| created_at.saturating_sub(existing.item.created_at) < interval);
            if should_reuse {
                return (existing.item.id.clone(), self.snapshot(), false);
            }
        }

        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id.to_string();
        self.items.push_front(StoredNotification {
            item: NotificationInboxItem {
                id: id.clone(),
                title,
                body,
                created_at,
                read_at: None,
                action,
            },
            key,
        });

        self.items.truncate(MAX_NOTIFICATION_ITEMS);
        self.revision = self.revision.saturating_add(1);
        (id, self.snapshot(), true)
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

    fn mark_all_read(&mut self, read_at: i64) -> bool {
        let mut changed = false;
        for stored in &mut self.items {
            if stored.item.read_at.is_none() {
                stored.item.read_at = Some(read_at);
                changed = true;
            }
        }
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        changed
    }

    fn load_from(path: &Path) -> Result<Self, String> {
        let data = match fs::read(path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(format!("알림함({}) 읽기 실패: {error}", path.display())),
        };
        let mut store: Self =
            serde_json::from_slice(&data).map_err(|error| format!("알림함({}) 파싱 실패: {error}", path.display()))?;
        if store.version != NOTIFICATION_INBOX_VERSION {
            let version_kind = if store.version > NOTIFICATION_INBOX_VERSION {
                "미래 버전"
            } else {
                "버전"
            };
            return Err(format!(
                "알림함({}) 안전한 로드 실패: 지원하지 않는 {version_kind} {}입니다(현재 {}).",
                path.display(),
                store.version,
                NOTIFICATION_INBOX_VERSION
            ));
        }
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
    publication: Mutex<()>,
}

impl NotificationInboxService {
    pub fn load() -> Self {
        Self::load_with_path(notification_inbox_path())
    }

    fn load_with_path(path: Option<PathBuf>) -> Self {
        let (path, store) = match path {
            Some(path) => match NotificationInboxStore::load_from(&path) {
                Ok(store) => (Some(path), store),
                Err(error) => {
                    log::error!(
                        "[notification-inbox] 안전한 로드 실패: {error}; 기존 파일 보호를 위해 쓰기를 비활성화합니다"
                    );
                    (None, NotificationInboxStore::default())
                }
            },
            None => (None, NotificationInboxStore::default()),
        };
        Self {
            path,
            store: Mutex::new(store),
            publication: Mutex::new(()),
        }
    }

    pub fn initialize(&self, app: &tauri::AppHandle) {
        apply_unread_badge(app);
    }

    pub fn record(
        &self,
        app: &tauri::AppHandle,
        key: &str,
        title: &str,
        body: &str,
        action: Option<NotificationAction>,
        repeat_after_ms: Option<i64>,
    ) -> Result<(String, NotificationInboxSnapshot, bool), String> {
        let path = self.path.as_deref().ok_or_else(writes_disabled_error)?;
        let mut store = self
            .store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())?;
        let mut next = store.clone();
        let (id, snapshot, inserted) = next.push(
            key.to_owned(),
            title.to_owned(),
            body.to_owned(),
            action,
            repeat_after_ms,
            Utc::now().timestamp_millis(),
        );
        if inserted {
            next.save_to(path)?;
            *store = next;
        }
        drop(store);
        if inserted {
            self.publish_if_current(app, &snapshot);
        }
        Ok((id, snapshot, inserted))
    }

    pub fn snapshot(&self) -> Result<NotificationInboxSnapshot, String> {
        self.store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())
            .map(|store| store.snapshot())
    }

    fn mark_read(
        &self,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<(NotificationInboxSnapshot, Option<NotificationAction>), String> {
        let path = self.path.as_deref().ok_or_else(writes_disabled_error)?;
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
            self.publish_if_current(app, &snapshot);
        }
        Ok((snapshot, action))
    }

    pub(crate) fn mark_read_without_activation(
        &self,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<NotificationInboxSnapshot, String> {
        self.mark_read(app, id).map(|(snapshot, _)| snapshot)
    }

    pub(crate) fn mark_all_read(&self, app: &tauri::AppHandle) -> Result<NotificationInboxSnapshot, String> {
        let path = self.path.as_deref().ok_or_else(writes_disabled_error)?;
        let mut store = self
            .store
            .lock()
            .map_err(|_| "알림함 잠금이 손상되었습니다.".to_string())?;
        let mut next = store.clone();
        let previous_revision = next.revision;
        if next.mark_all_read(Utc::now().timestamp_millis()) {
            next.save_to(path)?;
            *store = next;
        }
        let snapshot = store.snapshot();
        drop(store);

        if snapshot.revision != previous_revision {
            self.publish_if_current(app, &snapshot);
        }
        Ok(snapshot)
    }

    pub fn activate(&self, app: &tauri::AppHandle, id: &str) -> Result<NotificationInboxSnapshot, String> {
        let (snapshot, action) = self.mark_read(app, id)?;
        tray::open_dashboard_route(app, activation_dashboard_route(action))?;
        Ok(snapshot)
    }

    fn publish_if_current(&self, app: &tauri::AppHandle, snapshot: &NotificationInboxSnapshot) {
        let _publication = match self.publication.lock() {
            Ok(publication) => publication,
            Err(_) => {
                log::error!("[notification-inbox] 발행 잠금이 손상되어 snapshot 발행을 건너뜁니다");
                return;
            }
        };
        let current_revision = match self.store.lock() {
            Ok(store) => store.revision,
            Err(_) => {
                log::error!("[notification-inbox] 알림함 잠금이 손상되어 snapshot 발행을 건너뜁니다");
                return;
            }
        };
        if current_revision == snapshot.revision {
            publish_snapshot(app, snapshot);
        }
    }
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

fn writes_disabled_error() -> String {
    "알림함 안전 로드에 실패했거나 저장 경로를 확인할 수 없어 기존 파일 보호를 위해 쓰기가 비활성화되었습니다.".into()
}

fn publish_snapshot(app: &tauri::AppHandle, snapshot: &NotificationInboxSnapshot) {
    if let Err(error) = app.emit_to("dashboard", NOTIFICATION_INBOX_UPDATED_EVENT, snapshot) {
        log::debug!("[notification-inbox] snapshot emit skipped: {error}");
    }
    apply_unread_badge(app);
}

fn apply_unread_badge(app: &tauri::AppHandle) {
    let app = app.clone();
    if let Err(error) = app.clone().run_on_main_thread(move || {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let unread_count = {
            let service = app.state::<std::sync::Arc<NotificationInboxService>>();
            match service.snapshot() {
                Ok(snapshot) => snapshot.unread_count,
                Err(error) => {
                    log::debug!("[notification-inbox] 최신 배지 상태 확인 생략: {error}");
                    return;
                }
            }
        };

        #[cfg(target_os = "macos")]
        {
            let label = (unread_count > 0).then(|| "•".to_string());
            if let Some(window) = ["checker", "dashboard"]
                .into_iter()
                .find_map(|label| app.get_webview_window(label))
            {
                if let Err(error) = window.set_badge_label(label) {
                    log::debug!("[notification-inbox] macOS Dock 배지 적용 생략: {error}");
                }
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
        key: &str,
        title: &str,
        action: Option<NotificationAction>,
        repeat_after_ms: Option<i64>,
        created_at: i64,
    ) -> (String, NotificationInboxSnapshot, bool) {
        store.push(
            key.into(),
            title.into(),
            "알림 내용".into(),
            action,
            repeat_after_ms,
            created_at,
        )
    }

    #[test]
    fn 새_알림은_최신순으로_쌓이고_미읽음_수에_포함된다() {
        let mut store = NotificationInboxStore::default();
        push(
            &mut store,
            "source.first",
            "첫 알림",
            Some(NotificationAction::Attendance),
            None,
            1_000,
        );
        let (_, snapshot, inserted) = push(
            &mut store,
            "source.second",
            "두 번째 알림",
            Some(NotificationAction::Laundry),
            None,
            2_000,
        );

        assert!(inserted);
        assert_eq!(snapshot.unread_count, 2);
        assert_eq!(snapshot.items[0].title, "두 번째 알림");
        assert_eq!(snapshot.items[1].title, "첫 알림");
        assert!(snapshot.items.iter().all(|item| item.read_at.is_none()));
    }

    #[test]
    fn 같은_source의_one_shot은_기존_id와_revision을_그대로_재사용한다() {
        let mut store = NotificationInboxStore::default();
        let (id, first, inserted) = push(
            &mut store,
            "attendance:2026-07-29",
            "출석 알림",
            Some(NotificationAction::Attendance),
            None,
            1_000,
        );
        assert!(inserted);
        assert_eq!(first.items[0].id, id);
        store.mark_read(&id, 1_500).unwrap();
        let revision = store.revision;

        let (reused_id, unchanged, inserted) = push(
            &mut store,
            "attendance:2026-07-29",
            "출석 재알림",
            Some(NotificationAction::Attendance),
            None,
            2_000,
        );

        assert!(!inserted);
        assert_eq!(reused_id, id);
        assert_eq!(unchanged.revision, revision);
        assert_eq!(unchanged.items.len(), 1);
        assert_eq!(unchanged.items[0].title, "출석 알림");
        assert_eq!(unchanged.items[0].created_at, 1_000);
        assert_eq!(unchanged.items[0].read_at, Some(1_500));
        assert_eq!(unchanged.unread_count, 0);
    }

    #[test]
    fn 같은_source의_반복_알림은_주기_안에서_억제된다() {
        let mut store = NotificationInboxStore::default();
        let (id, first, _) = push(
            &mut store,
            "attendance.start:2026-07-29",
            "출석 알림",
            Some(NotificationAction::Attendance),
            Some(15 * 60 * 1_000),
            1_000,
        );

        let (reused_id, unchanged, inserted) = push(
            &mut store,
            "attendance.start:2026-07-29",
            "출석 재알림",
            Some(NotificationAction::Attendance),
            Some(15 * 60 * 1_000),
            1_000 + 15 * 60 * 1_000 - 1,
        );

        assert!(!inserted);
        assert_eq!(reused_id, id);
        assert_eq!(unchanged.revision, first.revision);
        assert_eq!(unchanged.items.len(), 1);
        assert_eq!(unchanged.items[0].title, "출석 알림");
    }

    #[test]
    fn 같은_source의_반복_알림은_주기_경계에서_새_id로_추가된다() {
        let mut store = NotificationInboxStore::default();
        let (first_id, first, _) = push(
            &mut store,
            "attendance.end:2026-07-29",
            "퇴근 출석 알림",
            Some(NotificationAction::Attendance),
            Some(15 * 60 * 1_000),
            1_000,
        );

        let (second_id, repeated, inserted) = push(
            &mut store,
            "attendance.end:2026-07-29",
            "퇴근 출석 재알림",
            Some(NotificationAction::Attendance),
            Some(15 * 60 * 1_000),
            1_000 + 15 * 60 * 1_000,
        );

        assert!(inserted);
        assert_ne!(second_id, first_id);
        assert_eq!(repeated.revision, first.revision + 1);
        assert_eq!(repeated.items.len(), 2);
        assert_eq!(repeated.items[0].id, second_id);
        assert_eq!(repeated.items[1].id, first_id);
    }

    #[test]
    fn 반복해서_추가된_알림은_각_id로_독립적으로_읽을_수_있다() {
        let mut store = NotificationInboxStore::default();
        let (first_id, _, _) = push(
            &mut store,
            "attendance.start:2026-07-29",
            "첫 출석 알림",
            Some(NotificationAction::Attendance),
            Some(100),
            1_000,
        );
        let (second_id, _, _) = push(
            &mut store,
            "attendance.start:2026-07-29",
            "두 번째 출석 알림",
            Some(NotificationAction::Attendance),
            Some(100),
            1_100,
        );

        store.mark_read(&first_id, 1_200).unwrap();
        let after_first = store.snapshot();
        assert_eq!(
            after_first
                .items
                .iter()
                .find(|item| item.id == first_id)
                .unwrap()
                .read_at,
            Some(1_200)
        );
        assert_eq!(
            after_first
                .items
                .iter()
                .find(|item| item.id == second_id)
                .unwrap()
                .read_at,
            None
        );

        store.mark_read(&second_id, 1_300).unwrap();
        assert_eq!(store.snapshot().unread_count, 0);
    }

    #[test]
    fn 알림_활성화는_해당_항목만_읽음으로_바꾸고_이동_대상을_반환한다() {
        let mut store = NotificationInboxStore::default();
        let (first_id, _, _) = push(
            &mut store,
            "attendance",
            "출석",
            Some(NotificationAction::Attendance),
            None,
            1_000,
        );
        push(
            &mut store,
            "meals",
            "식단",
            Some(NotificationAction::Meals),
            None,
            2_000,
        );

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
    fn 이동없는_읽음_처리는_액션을_보존하고_반복_호출에_멱등이다() {
        let mut store = NotificationInboxStore::default();
        let (id, _, _) = push(
            &mut store,
            "laundry",
            "세탁 완료",
            Some(NotificationAction::Laundry),
            None,
            1_000,
        );

        assert_eq!(store.mark_read(&id, 2_000).unwrap(), Some(NotificationAction::Laundry));
        let first = store.snapshot();
        assert_eq!(first.unread_count, 0);
        assert_eq!(first.items[0].read_at, Some(2_000));

        assert_eq!(store.mark_read(&id, 3_000).unwrap(), Some(NotificationAction::Laundry));
        assert_eq!(store.snapshot(), first);
    }

    #[test]
    fn 전체_읽음_처리는_새_알림만_같은_시각으로_갱신하고_revision을_한_번만_올린다() {
        let mut store = NotificationInboxStore::default();
        let (first_id, _, _) = push(&mut store, "first", "첫 번째", None, None, 1_000);
        push(&mut store, "second", "두 번째", None, None, 1_100);
        push(&mut store, "third", "세 번째", None, None, 1_200);
        store.mark_read(&first_id, 1_500).unwrap();
        let revision = store.revision;

        assert!(store.mark_all_read(2_000));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.unread_count, 0);
        assert_eq!(snapshot.revision, revision + 1);
        assert_eq!(
            snapshot.items.iter().map(|item| item.read_at).collect::<Vec<_>>(),
            vec![Some(2_000), Some(2_000), Some(1_500)]
        );

        assert!(!store.mark_all_read(3_000));
        assert_eq!(store.snapshot(), snapshot);
    }

    #[test]
    fn 알림함_항목_활성화는_도메인_액션을_유지하고_일반_알림은_알림함을_연다() {
        assert_eq!(
            activation_dashboard_route(Some(NotificationAction::Attendance)),
            DashboardRoute::Attendance
        );
        assert_eq!(activation_dashboard_route(None), DashboardRoute::Notifications);
    }

    #[test]
    fn 알림함은_최신_백개만_보존한다() {
        let mut store = NotificationInboxStore::default();
        for index in 0..=MAX_NOTIFICATION_ITEMS {
            push(
                &mut store,
                &format!("source.{index}"),
                &format!("알림 {index}"),
                None,
                None,
                index as i64 + 1,
            );
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
        let (id, _, _) = push(
            &mut store,
            "laundry",
            "세탁 완료",
            Some(NotificationAction::Laundry),
            None,
            1_000,
        );
        store.mark_read(&id, 2_000).unwrap();
        store.save_to(&path).unwrap();

        let restored = NotificationInboxStore::load_from(&path).unwrap();
        assert_eq!(restored.snapshot(), store.snapshot());

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn 미래_버전_알림함은_안전하게_거부한다() {
        let temp_dir =
            std::env::temp_dir().join(format!("jungle-bell-notification-inbox-future-{}", std::process::id()));
        let path = temp_dir.join("notifications.json");
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let store = NotificationInboxStore {
            version: NOTIFICATION_INBOX_VERSION + 1,
            ..NotificationInboxStore::default()
        };
        std::fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();

        let error = NotificationInboxStore::load_from(&path).unwrap_err();
        assert!(error.contains("미래 버전"));

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn 알림함_저장소는_현재_버전의_exact_snapshot만_받는다() {
        let mut store = NotificationInboxStore::default();
        store.push(
            "strict-snapshot".into(),
            "제목".into(),
            "본문".into(),
            None,
            None,
            1_700_000_000_000,
        );
        let current = serde_json::to_value(store).unwrap();
        let mut version_zero = current.clone();
        version_zero["version"] = serde_json::json!(0);
        let mut unsupported = current.clone();
        unsupported["version"] = serde_json::json!(NOTIFICATION_INBOX_VERSION + 1);
        let mut unknown_store_field = current.clone();
        unknown_store_field["unknown"] = serde_json::json!(true);

        let without_store_field = |field: &str| {
            let mut value = current.clone();
            value.as_object_mut().unwrap().remove(field);
            value
        };
        let without_item_field = |field: &str| {
            let mut value = current.clone();
            value["items"][0]["item"].as_object_mut().unwrap().remove(field);
            value
        };
        let mut unknown_stored_field = current.clone();
        unknown_stored_field["items"][0]["unknown"] = serde_json::json!(true);
        let mut unknown_item_field = current.clone();
        unknown_item_field["items"][0]["item"]["unknown"] = serde_json::json!(true);

        for (name, value) in [
            ("missing-version", without_store_field("version")),
            ("missing-revision", without_store_field("revision")),
            ("missing-next-id", without_store_field("next_id")),
            ("missing-items", without_store_field("items")),
            ("missing-stored-item", {
                let mut value = current.clone();
                value["items"][0].as_object_mut().unwrap().remove("item");
                value
            }),
            ("missing-stored-key", {
                let mut value = current.clone();
                value["items"][0].as_object_mut().unwrap().remove("key");
                value
            }),
            ("missing-item-id", without_item_field("id")),
            ("missing-item-title", without_item_field("title")),
            ("missing-item-body", without_item_field("body")),
            ("missing-item-created-at", without_item_field("createdAt")),
            ("missing-item-read-at", without_item_field("readAt")),
            ("missing-item-action", without_item_field("action")),
            ("version-zero", version_zero),
            ("unsupported-version", unsupported),
            ("unknown-store-field", unknown_store_field),
            ("unknown-stored-field", unknown_stored_field),
            ("unknown-item-field", unknown_item_field),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("{name}.json"));
            std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                NotificationInboxStore::load_from(&path).is_err(),
                "{name} must be rejected"
            );
        }
    }

    #[test]
    fn 안전한_로드가_실패하면_기존_파일_보호를_위해_쓰기를_비활성화한다() {
        let temp_dir =
            std::env::temp_dir().join(format!("jungle-bell-notification-inbox-invalid-{}", std::process::id()));
        let path = temp_dir.join("notifications.json");
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();
        std::fs::write(&path, b"{invalid-json").unwrap();

        let service = NotificationInboxService::load_with_path(Some(path));

        assert!(service.path.is_none());
        assert!(service.snapshot().unwrap().items.is_empty());

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
