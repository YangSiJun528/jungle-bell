pub(crate) fn normalize_base_url(value: &str, allow_local_http: bool) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("데이터 API 주소가 설정되지 않았습니다.".into());
    }

    let is_https = value.starts_with("https://");
    let is_local_http =
        allow_local_http && (value.starts_with("http://127.0.0.1:") || value.starts_with("http://localhost:"));
    if !is_https && !is_local_http {
        return Err("데이터 API 주소는 HTTPS URL이어야 합니다.".into());
    }

    Ok(value.to_owned())
}

pub(crate) fn base_url() -> String {
    let configured = match option_env!("JUNGLE_BELL_DATA_API_URL") {
        Some(value) => value,
        None => panic!("JUNGLE_BELL_DATA_API_URL must be set when building jungle-bell"),
    };
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
}
