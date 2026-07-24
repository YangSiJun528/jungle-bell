//! `소식` 라벨이 붙은 `공지` Discussion을 정규화한 GitHub Pages 피드를 읽는다.
//!
//! 게시 파이프라인은 `.github/workflows/publish-news.yml`이 담당한다. 앱은 매시간
//! 같은 쿼리 URL을 사용하고, 마지막으로 성공한 응답을 디스크에 남겨 오프라인에서도
//! 이전 소식을 보여준다.

use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Mutex;

const NEWS_FEED_URL: &str = "https://yangsijun528.github.io/jungle-bell/news.json";
const CACHE_FILE_NAME: &str = "news-feed.json";
const MAX_ITEMS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeed {
    pub version: u32,
    pub generated_at: String,
    pub items: Vec<NewsItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NewsItemType,
    pub title: String,
    pub body: String,
    pub url: String,
    pub category: String,
    #[serde(default)]
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NewsItemType {
    Announcement,
    Poll,
    Question,
    Discussion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedNews {
    hour_bucket: i64,
    feed: NewsFeed,
}

pub struct NewsService {
    client: reqwest::Client,
    cache: Mutex<Option<CachedNews>>,
}

impl NewsService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Jungle-Bell/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build news HTTP client");

        Self {
            client,
            cache: Mutex::new(None),
        }
    }

    pub async fn get(&self, app: &tauri::AppHandle) -> Result<NewsFeed, String> {
        let hour_bucket = current_hour_bucket();
        let mut cache = self.cache.lock().await;

        if let Some(cached) = cache.as_ref().filter(|cached| cached.hour_bucket == hour_bucket) {
            return Ok(cached.feed.clone());
        }

        let cache_path = cache_path(app)?;
        if cache.is_none() {
            *cache = load_cache(&cache_path).await;
        }
        if let Some(cached) = cache.as_ref().filter(|cached| cached.hour_bucket == hour_bucket) {
            return Ok(cached.feed.clone());
        }

        match self.fetch(hour_bucket).await {
            Ok(feed) => {
                let cached = CachedNews {
                    hour_bucket,
                    feed: feed.clone(),
                };
                if let Err(error) = save_cache(&cache_path, &cached).await {
                    log::warn!("[news] cache write failed: {}", error);
                }
                *cache = Some(cached);
                Ok(feed)
            }
            Err(error) => {
                if let Some(cached) = cache.as_ref() {
                    log::warn!("[news] fetch failed; stale cache used: {}", error);
                    Ok(cached.feed.clone())
                } else {
                    Err(error)
                }
            }
        }
    }

    async fn fetch(&self, hour_bucket: i64) -> Result<NewsFeed, String> {
        let response = self
            .client
            .get(format!("{NEWS_FEED_URL}?hour={hour_bucket}"))
            .send()
            .await
            .map_err(|error| format!("소식 피드 요청 실패: {error}"))?
            .error_for_status()
            .map_err(|error| format!("소식 피드 응답 오류: {error}"))?;

        let feed = response
            .json::<NewsFeed>()
            .await
            .map_err(|error| format!("소식 피드 형식 오류: {error}"))?;
        validate_feed(&feed)?;
        log::info!("[news] feed refreshed: {} items", feed.items.len());
        Ok(feed)
    }
}

fn current_hour_bucket() -> i64 {
    Utc::now().timestamp() / 3_600
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join(CACHE_FILE_NAME))
        .map_err(|error| format!("소식 캐시 경로 확인 실패: {error}"))
}

async fn load_cache(path: &PathBuf) -> Option<CachedNews> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let cached = serde_json::from_slice::<CachedNews>(&bytes).ok()?;
    validate_feed(&cached.feed).ok()?;
    Some(cached)
}

async fn save_cache(path: &PathBuf, cached: &CachedNews) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "소식 캐시 디렉터리를 찾지 못했습니다.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("소식 캐시 디렉터리 생성 실패: {error}"))?;
    let bytes = serde_json::to_vec(cached).map_err(|error| format!("소식 캐시 직렬화 실패: {error}"))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| format!("소식 캐시 저장 실패: {error}"))
}

fn validate_feed(feed: &NewsFeed) -> Result<(), String> {
    if feed.version != 1 {
        return Err(format!("지원하지 않는 소식 피드 버전: {}", feed.version));
    }
    if feed.items.len() > MAX_ITEMS {
        return Err("소식 항목이 허용 개수를 초과했습니다.".to_string());
    }

    for item in &feed.items {
        if item.id.is_empty() || item.id.len() > 100 {
            return Err("잘못된 소식 ID입니다.".to_string());
        }
        if item.title.is_empty() || item.title.len() > 300 || item.body.len() > 20_000 {
            return Err("잘못된 소식 내용입니다.".to_string());
        }
        if item.kind != NewsItemType::Announcement || item.category != "공지" {
            return Err("공지 카테고리가 아닌 피드 항목입니다.".to_string());
        }
        validate_news_url(&item.url)?;
    }
    Ok(())
}

pub fn validate_news_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "잘못된 소식 링크입니다.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("허용되지 않은 소식 링크입니다.".to_string());
    }

    let segments: Vec<_> = url
        .path_segments()
        .map(|segments| segments.collect())
        .unwrap_or_default();
    let is_discussion = matches!(segments.as_slice(), ["YangSiJun528", "jungle-bell", "discussions", _]);
    if !is_discussion {
        return Err("허용되지 않은 소식 링크입니다.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_feed, validate_news_url, NewsFeed, NewsItem, NewsItemType};

    fn valid_item() -> NewsItem {
        NewsItem {
            id: "discussion-12".to_string(),
            kind: NewsItemType::Announcement,
            title: "새 공지".to_string(),
            body: "내용".to_string(),
            url: "https://github.com/YangSiJun528/jungle-bell/discussions/12".to_string(),
            category: "공지".to_string(),
            pinned: false,
            created_at: "2026-07-24T00:00:00Z".to_string(),
            updated_at: "2026-07-24T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn 저장소의_discussion_링크만_허용한다() {
        assert!(validate_news_url("https://github.com/YangSiJun528/jungle-bell/discussions/12").is_ok());
        assert!(validate_news_url("https://github.com/YangSiJun528/jungle-bell/releases/tag/v0.4.4").is_err());
        assert!(validate_news_url("https://github.com/other/repo/discussions/12").is_err());
        assert!(validate_news_url("https://github.com/YangSiJun528/jungle-bell/issues/12").is_err());
        assert!(validate_news_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn 피드_버전과_항목을_검증한다() {
        let valid = NewsFeed {
            version: 1,
            generated_at: "2026-07-24T00:00:00Z".to_string(),
            items: vec![valid_item()],
        };
        assert!(validate_feed(&valid).is_ok());

        let wrong_category = NewsFeed {
            items: vec![NewsItem {
                kind: NewsItemType::Question,
                category: "궁금해요".to_string(),
                ..valid_item()
            }],
            ..valid.clone()
        };
        assert!(validate_feed(&wrong_category).is_err());

        let invalid = NewsFeed { version: 2, ..valid };
        assert!(validate_feed(&invalid).is_err());
    }
}
