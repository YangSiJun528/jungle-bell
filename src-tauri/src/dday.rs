use chrono::{DateTime, FixedOffset, NaiveDate};
use serde::Serialize;

use crate::config::Config;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DdayDisplay {
    pub badge: String,
    pub summary: String,
    pub target_date: String,
}

pub fn normalize_label(value: &mut String) -> bool {
    let trimmed = value.trim().to_string();
    let changed = *value != trimmed;
    if changed {
        *value = trimmed;
    }
    changed
}

pub fn validate_target_date(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let parsed = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .map_err(|_| "디데이 날짜 형식이 올바르지 않습니다.".to_string())?;

    Ok(Some(parsed.format("%Y-%m-%d").to_string()))
}

pub fn normalize_target_date(value: &mut Option<String>) -> bool {
    let original = value.clone();
    *value = validate_target_date(value.clone()).unwrap_or_else(|_| {
        log::warn!("[config] invalid dday_target_date detected, clearing value");
        None
    });

    *value != original
}

pub fn compute_display(config: &Config, kst_now: DateTime<FixedOffset>) -> Option<DdayDisplay> {
    if !config.dday_enabled {
        return None;
    }

    let target_raw = config.dday_target_date.as_deref()?;
    let target_date = NaiveDate::parse_from_str(target_raw, "%Y-%m-%d").ok()?;
    let today = kst_now.date_naive();
    let days = (target_date - today).num_days();

    let badge = match days.cmp(&0) {
        std::cmp::Ordering::Greater => format!("D-{days}"),
        std::cmp::Ordering::Equal => "D-Day".to_string(),
        std::cmp::Ordering::Less => format!("D+{}", days.abs()),
    };

    let label = config.dday_label.trim();
    let summary = if label.is_empty() {
        badge.clone()
    } else {
        format!("{label} · {badge}")
    };

    Some(DdayDisplay {
        badge,
        summary,
        target_date: target_date.format("%Y-%m-%d").to_string(),
    })
}

pub fn build_status_text(config: &Config, kst_now: DateTime<FixedOffset>) -> String {
    if !config.dday_enabled {
        return "사용 안 함".to_string();
    }

    match compute_display(config, kst_now) {
        Some(display) => display.summary,
        None if config.dday_target_date.is_none() => "날짜를 선택하세요".to_string(),
        None => "날짜 형식을 확인하세요".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn kst_dt(y: i32, m: u32, d: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, m, d, 12, 0, 0)
            .unwrap()
    }

    fn config(date: Option<&str>, enabled: bool, label: &str) -> Config {
        let mut config = Config::default();
        config.dday_enabled = enabled;
        config.dday_label = label.to_string();
        config.dday_target_date = date.map(|value| value.to_string());
        config
    }

    #[test]
    fn 미래_날짜는_d_마이너스로_계산한다() {
        let display = compute_display(&config(Some("2026-04-20"), true, "최종 발표"), kst_dt(2026, 4, 16)).unwrap();
        assert_eq!(display.badge, "D-4");
        assert_eq!(display.summary, "최종 발표 · D-4");
    }

    #[test]
    fn 당일은_d_day로_표시한다() {
        let display = compute_display(&config(Some("2026-04-16"), true, "출석"), kst_dt(2026, 4, 16)).unwrap();
        assert_eq!(display.badge, "D-Day");
    }

    #[test]
    fn 지난_날짜는_d_플러스로_계산한다() {
        let display = compute_display(&config(Some("2026-04-14"), true, "출석"), kst_dt(2026, 4, 16)).unwrap();
        assert_eq!(display.badge, "D+2");
    }

    #[test]
    fn 라벨이_비어있으면_badge만_표시한다() {
        let display = compute_display(&config(Some("2026-04-20"), true, ""), kst_dt(2026, 4, 16)).unwrap();
        assert_eq!(display.summary, "D-4");
    }

    #[test]
    fn 비활성화시_표시하지_않는다() {
        assert!(compute_display(&config(Some("2026-04-20"), false, "발표"), kst_dt(2026, 4, 16)).is_none());
    }

    #[test]
    fn 날짜_정규화는_공백을_제거하고_형식을_고정한다() {
        let normalized = validate_target_date(Some(" 2026-04-20 ".into())).unwrap();
        assert_eq!(normalized, Some("2026-04-20".into()));
    }

    #[test]
    fn 잘못된_날짜는_검증에서_실패한다() {
        assert!(validate_target_date(Some("2026-02-30".into())).is_err());
    }
}
