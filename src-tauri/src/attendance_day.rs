use chrono::{DateTime, Duration, FixedOffset, Timelike};

/// 현재 KST 날짜를 `YYYY-MM-DD` 문자열로 반환한다.
pub fn calendar_date_string(kst_now: DateTime<FixedOffset>) -> String {
    kst_now.format("%Y-%m-%d").to_string()
}

/// 자정~morning_start 사이는 전날 출석일로 간주한다.
pub fn effective_attendance_date(kst_now: DateTime<FixedOffset>) -> String {
    if kst_now.hour() < crate::config::MORNING_START_HOUR {
        return calendar_date_string(kst_now - Duration::days(1));
    }

    calendar_date_string(kst_now)
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
        assert_eq!(effective_attendance_date(kst_dt(2, 0, 0)), "2026-03-17");
    }

    #[test]
    fn morning_start_이후에는_오늘을_출석일로_본다() {
        assert_eq!(effective_attendance_date(kst_dt(9, 0, 0)), "2026-03-18");
    }

    #[test]
    fn calendar_date_string은_현재_달력_날짜를_반환한다() {
        let now = kst_dt(1, 30, 0);

        assert_eq!(calendar_date_string(now), "2026-03-18");
        assert_eq!(now.hour(), 1);
    }
}
