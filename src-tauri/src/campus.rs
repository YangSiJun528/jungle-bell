use std::time::Duration;

use chrono::{DateTime, FixedOffset, Timelike, Utc};
use reqwest::header::{ACCEPT, ETAG, IF_NONE_MATCH};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::data_api;
use crate::state::kst;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const LAUNDRY_INTERVAL_SECS: u64 = 30;
const MEALS_ACTIVE_INTERVAL_SECS: u64 = 60;
const MEALS_IDLE_INTERVAL_SECS: u64 = 5 * 60;
const MAX_MEAL_HISTORY_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MEAL_HISTORY_CURSOR_BYTES: usize = 2_048;
const CAMPUS_DATA_UPDATED_EVENT: &str = "campus-data-updated";
const CAMPUS_DATA_ERROR_EVENT: &str = "campus-data-error";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CampusDataKind {
    Laundry,
    Meals,
}

impl CampusDataKind {
    fn path(self) -> &'static str {
        match self {
            Self::Laundry => "/api/public/laundry",
            Self::Meals => "/api/public/meals",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Laundry => "laundry",
            Self::Meals => "meals",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusSnapshot {
    pub saved_at: i64,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CampusDataUpdate {
    kind: CampusDataKind,
    snapshot: CampusSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CampusDataError {
    kind: CampusDataKind,
    message: String,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    snapshot: CampusSnapshot,
    etag: Option<String>,
}

#[derive(Debug, Default)]
struct CampusCache {
    laundry: Option<CacheEntry>,
    meals: Option<CacheEntry>,
}

#[derive(Debug, Default)]
struct RequestTimes {
    laundry: Option<DateTime<Utc>>,
    meals: Option<DateTime<Utc>>,
}

impl RequestTimes {
    fn get(&self, kind: CampusDataKind) -> Option<DateTime<Utc>> {
        match kind {
            CampusDataKind::Laundry => self.laundry,
            CampusDataKind::Meals => self.meals,
        }
    }

    fn set(&mut self, kind: CampusDataKind, value: DateTime<Utc>) {
        match kind {
            CampusDataKind::Laundry => self.laundry = Some(value),
            CampusDataKind::Meals => self.meals = Some(value),
        }
    }
}

impl CampusCache {
    fn entry(&self, kind: CampusDataKind) -> Option<&CacheEntry> {
        match kind {
            CampusDataKind::Laundry => self.laundry.as_ref(),
            CampusDataKind::Meals => self.meals.as_ref(),
        }
    }

    fn entry_mut(&mut self, kind: CampusDataKind) -> &mut Option<CacheEntry> {
        match kind {
            CampusDataKind::Laundry => &mut self.laundry,
            CampusDataKind::Meals => &mut self.meals,
        }
    }
}

pub struct CampusService {
    client: Client,
    base_url: String,
    cache: Mutex<CampusCache>,
    request_times: Mutex<RequestTimes>,
    laundry_request: Mutex<()>,
    meals_request: Mutex<()>,
}

impl CampusService {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("JungleBell/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build campus HTTP client");
        Self {
            client,
            base_url: data_api::base_url(),
            cache: Mutex::new(CampusCache::default()),
            request_times: Mutex::new(RequestTimes::default()),
            laundry_request: Mutex::new(()),
            meals_request: Mutex::new(()),
        }
    }

    fn request_lock(&self, kind: CampusDataKind) -> &Mutex<()> {
        match kind {
            CampusDataKind::Laundry => &self.laundry_request,
            CampusDataKind::Meals => &self.meals_request,
        }
    }

    async fn refresh_inner(
        &self,
        app: &tauri::AppHandle,
        kind: CampusDataKind,
        scheduled: bool,
    ) -> Result<Option<CampusSnapshot>, String> {
        let _request_guard = self.request_lock(kind).lock().await;
        let now = Utc::now();
        if scheduled {
            let interval = request_interval_secs(kind, now.with_timezone(&kst()));
            let last_attempt = self.request_times.lock().await.get(kind);
            if last_attempt.is_some_and(|last| (now - last).num_seconds() < interval as i64) {
                return Ok(None);
            }
        }
        self.request_times.lock().await.set(kind, now);

        let snapshot = self.fetch_and_cache(app, kind).await?;
        Ok(Some(snapshot))
    }

    async fn fetch_and_cache(&self, app: &tauri::AppHandle, kind: CampusDataKind) -> Result<CampusSnapshot, String> {
        let etag = self.cache.lock().await.entry(kind).and_then(|entry| entry.etag.clone());

        let mut request = self
            .client
            .get(format!("{}{}", self.base_url, kind.path()))
            .header(ACCEPT, "application/json");
        if let Some(etag) = etag {
            request = request.header(IF_NONE_MATCH, etag);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("{} request failed: {error}", kind.name()))?;
        let saved_at = Utc::now().timestamp_millis();

        let snapshot = if response.status() == StatusCode::NOT_MODIFIED {
            let mut cache = self.cache.lock().await;
            let entry = cache
                .entry_mut(kind)
                .as_mut()
                .ok_or_else(|| format!("{} returned 304 without cached data", kind.name()))?;
            entry.snapshot.saved_at = saved_at;
            entry.snapshot.clone()
        } else {
            let response = response
                .error_for_status()
                .map_err(|error| format!("{} request failed: {error}", kind.name()))?;
            let etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let data = response
                .json::<Value>()
                .await
                .map_err(|error| format!("{} response was not valid JSON: {error}", kind.name()))?;
            validate_payload(kind, &data, &self.base_url)?;
            let snapshot = CampusSnapshot { saved_at, data };
            *self.cache.lock().await.entry_mut(kind) = Some(CacheEntry {
                snapshot: snapshot.clone(),
                etag,
            });
            snapshot
        };

        let _ = app.emit(
            CAMPUS_DATA_UPDATED_EVENT,
            CampusDataUpdate {
                kind,
                snapshot: snapshot.clone(),
            },
        );
        Ok(snapshot)
    }

    pub async fn refresh(&self, app: &tauri::AppHandle, kind: CampusDataKind) -> Result<(), String> {
        self.refresh_inner(app, kind, false).await.map(|_| ())
    }

    /// 대시보드 WebView에는 외부 API origin을 열지 않고 검증된 공개 데이터만 넘긴다.
    /// 네트워크 갱신에 실패해도 프로세스 내 검증 캐시가 있으면 마지막 snapshot을
    /// 반환해 일시적인 연결 장애에서 공개 화면이 비지 않게 한다.
    pub async fn dashboard_data(&self, app: &tauri::AppHandle, kind: CampusDataKind) -> Result<Value, String> {
        let cached = self.cache.lock().await.entry(kind).map(|entry| entry.snapshot.clone());
        match self.refresh_inner(app, kind, false).await {
            Ok(Some(snapshot)) => Ok(snapshot.data),
            Ok(None) => cached
                .map(|snapshot| snapshot.data)
                .ok_or_else(|| format!("{} data is not available", kind.name())),
            Err(error) => match cached {
                Some(snapshot) => {
                    log::warn!(
                        "[campus] {} refresh failed; serving validated cache: {error}",
                        kind.name()
                    );
                    Ok(snapshot.data)
                }
                None => Err(error),
            },
        }
    }

    /// 대시보드의 과거 급식 탐색을 위한 읽기 전용 페이지 프록시.
    /// WebView에는 API origin 접근 권한을 주지 않고 제한된 cursor/limit만 전달한다.
    pub async fn meal_history(&self, before: Option<&str>, limit: u8) -> Result<Value, String> {
        let url = meal_history_url(&self.base_url, before, limit)?;
        let mut response = self
            .client
            .get(url)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("meal history request failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("meal history request failed: {error}"))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MEAL_HISTORY_RESPONSE_BYTES)
        {
            return Err("meal history response was too large".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("meal history response body failed: {error}"))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_MEAL_HISTORY_RESPONSE_BYTES as usize {
                return Err("meal history response was too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice::<Value>(&body)
            .map_err(|error| format!("meal history response was not valid JSON: {error}"))?;
        validate_meal_history_payload(&value, &self.base_url)?;
        Ok(value)
    }

    pub async fn cached_dashboard_data(&self, kind: CampusDataKind) -> Option<Value> {
        self.cache
            .lock()
            .await
            .entry(kind)
            .map(|entry| entry.snapshot.data.clone())
    }

    pub async fn refresh_scheduled(&self, app: &tauri::AppHandle, kind: CampusDataKind) -> Result<bool, String> {
        self.refresh_inner(app, kind, true)
            .await
            .map(|snapshot| snapshot.is_some())
    }

    pub async fn emit_cached_snapshots(&self, app: &tauri::AppHandle) {
        let snapshots = {
            let cache = self.cache.lock().await;
            [
                (
                    CampusDataKind::Laundry,
                    cache.entry(CampusDataKind::Laundry).map(|entry| entry.snapshot.clone()),
                ),
                (
                    CampusDataKind::Meals,
                    cache.entry(CampusDataKind::Meals).map(|entry| entry.snapshot.clone()),
                ),
            ]
        };
        for (kind, snapshot) in snapshots {
            if let Some(snapshot) = snapshot {
                let _ = app.emit(CAMPUS_DATA_UPDATED_EVENT, CampusDataUpdate { kind, snapshot });
            }
        }
    }

    pub fn emit_error(&self, app: &tauri::AppHandle, kind: CampusDataKind, message: String) {
        let _ = app.emit(CAMPUS_DATA_ERROR_EVENT, CampusDataError { kind, message });
    }
}

fn meal_history_url(base_url: &str, before: Option<&str>, limit: u8) -> Result<reqwest::Url, String> {
    if !(1..=100).contains(&limit) {
        return Err("급식 기록 요청 개수가 올바르지 않습니다.".into());
    }
    if let Some(cursor) = before {
        if !meal_history_cursor_valid(cursor) {
            return Err("급식 기록 cursor가 올바르지 않습니다.".into());
        }
    }

    let mut url = reqwest::Url::parse(base_url).map_err(|_| "급식 기록 서버 주소가 올바르지 않습니다.".to_string())?;
    url.set_path("/api/public/meals/history");
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        if let Some(cursor) = before {
            query.append_pair("before", cursor);
        }
        query.append_pair("limit", &limit.to_string());
    }
    Ok(url)
}

fn meal_history_cursor_valid(value: &str) -> bool {
    if value.len() < 26 || value.len() > MAX_MEAL_HISTORY_CURSOR_BYTES {
        return false;
    }
    let Some((timestamp, encoded_post_id)) = value.split_once('~') else {
        return false;
    };
    let timestamp_valid = DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .is_some_and(|parsed| parsed.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string() == timestamp);
    if !timestamp_valid || encoded_post_id.is_empty() {
        return false;
    }
    let bytes = encoded_post_id.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
                || bytes[index + 1].is_ascii_lowercase()
                || bytes[index + 2].is_ascii_lowercase()
            {
                return false;
            }
            index += 3;
            continue;
        }
        if !(byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'))
        {
            return false;
        }
        index += 1;
    }
    true
}

fn validate_meal_history_payload(value: &Value, expected_base_url: &str) -> Result<(), String> {
    let posts_valid = value.get("posts").is_some_and(Value::is_array);
    let cursor_valid = value
        .get("nextBefore")
        .is_some_and(|cursor| cursor.is_null() || cursor.as_str().is_some_and(meal_history_cursor_valid));
    let assets_valid = value
        .get("posts")
        .is_some_and(|posts| meal_post_list_assets_valid(posts, expected_base_url));
    (posts_valid && cursor_valid && assets_valid)
        .then_some(())
        .ok_or_else(|| "meal history response schema was invalid".into())
}

fn validate_payload(kind: CampusDataKind, data: &Value, expected_base_url: &str) -> Result<(), String> {
    let valid = match kind {
        CampusDataKind::Laundry => {
            data.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && data.get("machines").is_some_and(Value::is_array)
                && data.get("quality").is_some_and(Value::is_object)
        }
        CampusDataKind::Meals => {
            let meals = data.get("data");
            let current_weekly = meals.and_then(|value| value.get("currentWeeklyMenu"));
            let history_cursor_valid = meals
                .and_then(|value| value.get("historyNextBefore"))
                .is_none_or(|cursor| cursor.is_null() || cursor.as_str().is_some_and(meal_history_cursor_valid));
            let contract_valid = meals
                .and_then(|value| value.get("schemaVersion"))
                .and_then(Value::as_u64)
                == Some(2)
                && meals
                    .and_then(|value| value.get("dailyMenus"))
                    .is_some_and(Value::is_array)
                && meals
                    .and_then(|value| value.get("pinnedMenus"))
                    .is_some_and(Value::is_array)
                && current_weekly
                    .and_then(|value| value.get("targetWeekKey"))
                    .is_some_and(Value::is_string)
                && current_weekly
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str)
                    .is_some_and(|status| matches!(status, "AVAILABLE" | "AWAITING_UPDATE"))
                && current_weekly
                    .and_then(|value| value.get("post"))
                    .is_some_and(|post| post.is_null() || post.is_object())
                && history_cursor_valid;
            contract_valid && meals.is_some_and(|meals| meal_data_assets_valid(meals, expected_base_url))
        }
    };
    valid
        .then_some(())
        .ok_or_else(|| format!("{} response schema was invalid", kind.name()))
}

fn meal_data_assets_valid(data: &Value, expected_base_url: &str) -> bool {
    let direct_posts_valid = ["dailyMenus", "pinnedMenus", "recentMenus", "otherPosts"]
        .into_iter()
        .all(|key| {
            data.get(key)
                .is_none_or(|posts| meal_post_list_assets_valid(posts, expected_base_url))
        });
    let current_valid = data
        .get("currentWeeklyMenu")
        .and_then(|current| current.get("post"))
        .is_none_or(|post| post.is_null() || meal_post_assets_valid(post, expected_base_url));
    let weekly_valid = data.get("weeklyMenus").is_none_or(|menus| {
        menus.as_array().is_some_and(|menus| {
            menus.iter().all(|menu| {
                menu.get("post")
                    .is_some_and(|post| meal_post_assets_valid(post, expected_base_url))
            })
        })
    });
    direct_posts_valid && current_valid && weekly_valid
}

fn meal_post_list_assets_valid(posts: &Value, expected_base_url: &str) -> bool {
    posts
        .as_array()
        .is_some_and(|posts| posts.iter().all(|post| meal_post_assets_valid(post, expected_base_url)))
}

fn meal_post_assets_valid(post: &Value, expected_base_url: &str) -> bool {
    let Some(images) = post.get("images") else {
        return true;
    };
    images.as_array().is_some_and(|images| {
        images
            .iter()
            .all(|image| meal_image_asset_valid(image, expected_base_url))
    })
}

fn meal_image_asset_valid(image: &Value, expected_base_url: &str) -> bool {
    let Some(sha) = image.get("sha").and_then(Value::as_str) else {
        return false;
    };
    let Some(extension) = image.get("extension").and_then(Value::as_str) else {
        return false;
    };
    let Some(url) = image.get("url").and_then(Value::as_str) else {
        return false;
    };
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(extension, "avif" | "gif" | "jpg" | "jpeg" | "png" | "webp")
    {
        return false;
    }

    let Ok(expected) = reqwest::Url::parse(expected_base_url) else {
        return false;
    };
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == expected.scheme()
        && parsed.host_str() == expected.host_str()
        && parsed.port_or_known_default() == expected.port_or_known_default()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == format!("/api/public/assets/{sha}.{extension}")
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn in_meal_poll_window(seconds: u32) -> bool {
    (10 * 3600..12 * 3600 + 60).contains(&seconds) || (16 * 3600..18 * 3600 + 60).contains(&seconds)
}

pub(crate) fn request_interval_secs(kind: CampusDataKind, now: DateTime<FixedOffset>) -> u64 {
    match kind {
        CampusDataKind::Laundry => LAUNDRY_INTERVAL_SECS,
        CampusDataKind::Meals if in_meal_poll_window(now.num_seconds_from_midnight()) => MEALS_ACTIVE_INTERVAL_SECS,
        CampusDataKind::Meals => MEALS_IDLE_INTERVAL_SECS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn kst_time(hour: u32, minute: u32, second: u32) -> DateTime<FixedOffset> {
        kst().with_ymd_and_hms(2026, 7, 17, hour, minute, second).unwrap()
    }

    #[test]
    fn campus_service_builds_http_client() {
        let _service = CampusService::new();
    }

    #[test]
    fn public_data_uses_only_the_current_api_contract() {
        assert_eq!(CampusDataKind::Laundry.path(), "/api/public/laundry");
        assert_eq!(CampusDataKind::Meals.path(), "/api/public/meals");
    }

    #[test]
    fn meal_history_url_is_scoped_and_paginated() {
        let cursor = "2026-08-10T02:07:38.000Z~meal-30";
        let url = meal_history_url("https://data.example.com", Some(cursor), 30).unwrap();

        assert_eq!(url.path(), "/api/public/meals/history");
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![("before".into(), cursor.into()), ("limit".into(), "30".into())],
        );
    }

    #[test]
    fn meal_history_url_rejects_invalid_cursor_and_limit() {
        assert!(meal_history_url("https://data.example.com", Some("yesterday"), 30).is_err());
        assert!(meal_history_url("https://data.example.com", Some("2026-08-10T02:07:38.000Z"), 30).is_err());
        assert!(meal_history_url(
            "https://data.example.com",
            Some("2026-08-10T02:07:38.000Z~invalid%2fid"),
            30
        )
        .is_err());
        assert!(meal_history_url("https://data.example.com", None, 0).is_err());
        assert!(meal_history_url("https://data.example.com", None, 101).is_err());
    }

    #[test]
    fn meal_history_payload_requires_posts_and_nullable_cursor() {
        assert!(validate_meal_history_payload(
            &serde_json::json!({
                "posts": [],
                "nextBefore": null,
            }),
            "https://data.example.com"
        )
        .is_ok());
        assert!(validate_meal_history_payload(
            &serde_json::json!({
                "posts": [],
                "nextBefore": "2026-08-10T02:07:38.000Z~meal-30",
            }),
            "https://data.example.com"
        )
        .is_ok());
        assert!(validate_meal_history_payload(
            &serde_json::json!({
                "posts": {},
                "nextBefore": null,
            }),
            "https://data.example.com"
        )
        .is_err());
    }

    #[test]
    fn meal_payloads_reject_images_outside_the_configured_api_origin() {
        let post = |origin: &str| {
            serde_json::json!({
                "images": [{
                    "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "extension": "jpg",
                    "url": format!("{origin}/api/public/assets/{}.jpg", "a".repeat(64)),
                    "contentType": "image/jpeg"
                }]
            })
        };
        let root = |origin: &str| {
            serde_json::json!({
                "data": {
                    "schemaVersion": 2,
                    "dailyMenus": [post(origin)],
                    "pinnedMenus": [],
                    "recentMenus": [],
                    "currentWeeklyMenu": {
                        "targetWeekKey": "2026-08-10",
                        "status": "AWAITING_UPDATE",
                        "contentSha": null,
                        "post": null
                    }
                }
            })
        };

        assert!(validate_payload(
            CampusDataKind::Meals,
            &root("https://data.example.com"),
            "https://data.example.com"
        )
        .is_ok());
        assert!(validate_payload(
            CampusDataKind::Meals,
            &root("https://evil.example"),
            "https://data.example.com"
        )
        .is_err());
        assert!(validate_meal_history_payload(
            &serde_json::json!({
                "posts": [post("https://evil.example")],
                "nextBefore": null,
            }),
            "https://data.example.com"
        )
        .is_err());
    }

    #[test]
    fn meals_payload_requires_current_week_verdict() {
        let valid = serde_json::json!({
            "data": {
                "schemaVersion": 2,
                "dailyMenus": [],
                "pinnedMenus": [],
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-20",
                    "status": "AWAITING_UPDATE",
                    "contentSha": null,
                    "post": null
                }
            }
        });
        let old = serde_json::json!({
            "data": { "schemaVersion": 1, "dailyMenus": [], "pinnedMenus": [] }
        });

        assert!(validate_payload(CampusDataKind::Meals, &valid, "https://data.example.com").is_ok());
        assert!(validate_payload(CampusDataKind::Meals, &old, "https://data.example.com").is_err());
    }

    #[test]
    fn meals_poll_every_minute_during_pre_meal_windows() {
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(10, 0, 0)), 60);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(11, 59, 59)), 60);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(12, 0, 59)), 60);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(16, 0, 0)), 60);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(17, 59, 59)), 60);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(18, 0, 59)), 60);
    }

    #[test]
    fn meals_poll_every_five_minutes_outside_pre_meal_windows() {
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(9, 59, 59)), 300);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(12, 1, 0)), 300);
        assert_eq!(request_interval_secs(CampusDataKind::Meals, kst_time(18, 1, 0)), 300);
    }

    #[test]
    fn laundry_always_polls_every_thirty_seconds() {
        assert_eq!(request_interval_secs(CampusDataKind::Laundry, kst_time(3, 0, 0)), 30);
        assert_eq!(request_interval_secs(CampusDataKind::Laundry, kst_time(12, 0, 0)), 30);
    }
}
