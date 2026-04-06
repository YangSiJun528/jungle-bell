use chrono::{DateTime, Duration, FixedOffset, Timelike};

use crate::config::Config;

/// 현재 KST 날짜를 `YYYY-MM-DD` 문자열로 반환한다.
pub fn calendar_date_string(kst_now: DateTime<FixedOffset>) -> String {
    kst_now.format("%Y-%m-%d").to_string()
}

/// 자정~morning_start 사이는 전날 출석일로 간주한다.
pub fn effective_attendance_date(config: &Config, kst_now: DateTime<FixedOffset>) -> String {
    if kst_now.hour() < config.morning_start.hour as u32 {
        return calendar_date_string(kst_now - Duration::days(1));
    }

    calendar_date_string(kst_now)
}

/// 현재 시각 기준으로 `skip_attendance`가 활성화되어 있는지 판정한다.
pub fn is_skip_attendance_active(config: &Config, kst_now: DateTime<FixedOffset>) -> bool {
    let Some(skip_date) = config.skip_attendance.as_deref() else {
        return false;
    };

    skip_date == effective_attendance_date(config, kst_now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    fn kst_dt(h: u32, m: u32, s: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, h, m, s)
            .unwrap()
    }

    #[test]
    fn morning_start_이전에는_전날을_출석일로_본다() {
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-17".into());

        assert!(is_skip_attendance_active(&config, kst_dt(2, 0, 0)));
    }

    #[test]
    fn morning_start_이후에는_오늘을_출석일로_본다() {
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-18".into());

        assert!(is_skip_attendance_active(&config, kst_dt(9, 0, 0)));
    }

    #[test]
    fn calendar_date_string은_현재_달력_날짜를_반환한다() {
        let now = kst_dt(1, 30, 0);

        assert_eq!(calendar_date_string(now), "2026-03-18");
        assert_eq!(now.hour(), 1);
    }
}
