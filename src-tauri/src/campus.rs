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
            validate_payload(kind, &data)?;
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

fn validate_payload(kind: CampusDataKind, data: &Value) -> Result<(), String> {
    let valid = match kind {
        CampusDataKind::Laundry => {
            data.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && data.get("machines").is_some_and(Value::is_array)
                && data.get("quality").is_some_and(Value::is_object)
        }
        CampusDataKind::Meals => {
            let meals = data.get("data");
            let current_weekly = meals.and_then(|value| value.get("currentWeeklyMenu"));
            meals
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
        }
    };
    valid
        .then_some(())
        .ok_or_else(|| format!("{} response schema was invalid", kind.name()))
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

        assert!(validate_payload(CampusDataKind::Meals, &valid).is_ok());
        assert!(validate_payload(CampusDataKind::Meals, &old).is_err());
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
