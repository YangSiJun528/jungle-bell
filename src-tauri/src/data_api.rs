const DEFAULT_DEV_API_ORIGIN: &str = "https://jungle-bell-api-test.yangsijun5528.workers.dev";

pub(crate) fn normalize_base_url(value: &str, allow_local_http: bool) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("데이터 API 주소가 설정되지 않았습니다.".into());
    }

    let url = reqwest::Url::parse(value).map_err(|_| "데이터 API 주소가 올바른 URL이 아닙니다.".to_string())?;
    let is_https = url.scheme() == "https";
    let is_local_http =
        allow_local_http && url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if (!is_https && !is_local_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("데이터 API 주소는 HTTPS URL이어야 합니다.".into());
    }

    Ok(value.to_owned())
}

#[cfg(test)]
fn configured_base_url() -> &'static str {
    option_env!("JUNGLE_BELL_DATA_API_URL").unwrap_or("https://data-api.test")
}

#[cfg(all(not(test), debug_assertions))]
fn configured_base_url() -> &'static str {
    option_env!("JUNGLE_BELL_DATA_API_URL").unwrap_or(DEFAULT_DEV_API_ORIGIN)
}

#[cfg(all(not(test), not(debug_assertions)))]
fn configured_base_url() -> &'static str {
    option_env!("JUNGLE_BELL_DATA_API_URL")
        .unwrap_or_else(|| panic!("JUNGLE_BELL_DATA_API_URL must be set when building jungle-bell"))
}

pub(crate) fn base_url() -> String {
    let configured = configured_base_url();
    normalize_base_url(configured, cfg!(debug_assertions))
        .unwrap_or_else(|error| panic!("invalid JUNGLE_BELL_DATA_API_URL: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_trailing_slashes() {
        assert_eq!(
            normalize_base_url(" https://data.example.com/// ", false).unwrap(),
            "https://data.example.com"
        );
    }

    #[test]
    fn rejects_plain_http_in_release_mode() {
        assert!(normalize_base_url("http://data.example.com", false).is_err());
    }

    #[test]
    fn allows_only_loopback_http_in_debug_mode() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:8787/", true).unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_base_url("http://192.168.0.10:8787", true).is_err());
    }

    #[test]
    fn rejects_credentials_paths_queries_and_fragments() {
        for invalid in [
            "https://user:secret@data.example.com",
            "https://data.example.com/api",
            "https://data.example.com?token=secret",
            "https://data.example.com/#fragment",
        ] {
            assert!(normalize_base_url(invalid, true).is_err(), "{invalid}");
        }
    }

    #[test]
    fn tests_have_a_deterministic_origin_without_build_environment() {
        assert!(base_url().starts_with("https://"));
    }

    #[test]
    fn debug_builds_default_to_the_v2_test_worker() {
        assert_eq!(
            DEFAULT_DEV_API_ORIGIN,
            "https://jungle-bell-api-test.yangsijun5528.workers.dev"
        );
    }
}
