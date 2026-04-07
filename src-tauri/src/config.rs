use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

/// 시각 값 (시 + 분). 스케줄 경계 설정에 사용.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeOfDay {
    pub hour: u32,
    pub minute: u32,
}

/// 출석 체크 시간대 설정.
///
/// 하루가 다음 시간대로 나뉨:
///   morning_start ~ morning_end  : 학습 시작(체크인) 목표 시간  (04:00 ~ 10:00)
///   morning_end   ~ evening_start: 학습 중, 액션 없음          (10:00 ~ 23:00)
///   evening_start ~ evening_end  : 학습 종료(체크아웃) 시간     (23:00 ~ 04:00)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// 하루 시작 / 체크인 가능 시작 (기본 04:00)
    pub morning_start: TimeOfDay,
    /// 체크인 목표 마감 (기본 10:00, 이후는 지각)
    pub morning_end: TimeOfDay,
    /// 체크아웃 가능 시작 (기본 23:00)
    pub evening_start: TimeOfDay,
    /// 체크아웃 마감 / 하루 끝 (기본 다음 날 04:00)
    pub evening_end: TimeOfDay,
    /// 앱 시작 시 자동 업데이트 확인 여부 (기본 true)
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// 시스템 시작 시 앱 자동 실행 여부 (기본 true)
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// 시작 출석 알림 활성화 여부 (기본 true)
    #[serde(default = "default_true")]
    pub start_notification_enabled: bool,
    /// 종료 출석 알림 활성화 여부 (기본 true)
    #[serde(default = "default_true")]
    pub end_notification_enabled: bool,
    /// 시작 출석 알림 간격 (분, 기본 15)
    #[serde(default = "default_notification_interval")]
    pub start_notification_interval_mins: u32,
    /// 종료 출석 알림 간격 (분, 기본 15)
    #[serde(default = "default_notification_interval")]
    pub end_notification_interval_mins: u32,
    /// 알림 시작 시각 — 이 시각 이전에는 아침 알림을 보내지 않음 (기본 09:00)
    #[serde(default = "default_notification_start")]
    pub notification_start: TimeOfDay,
    /// 알림 종료 시각 — 이 시각 이후에는 저녁 알림을 보내지 않음 (기본 01:00)
    #[serde(default = "default_notification_end")]
    pub notification_end: TimeOfDay,
    /// 디버그 모드 — 활성화 시 상세 로그 출력 (기본 false)
    #[serde(default)]
    pub debug_mode: bool,
    /// 환영 알림 발송 완료 여부 (기본 false)
    /// 기존 config에 필드가 없으면 false → 신규/기존 사용자 모두 한 번 알림 수신.
    #[serde(default)]
    pub welcome_notification_sent: bool,
    /// 마지막으로 실행된 앱 버전. 업데이트 완료 알림 판단에 사용.
    /// None이면 첫 설치 (환영 알림 대상).
    #[serde(default)]
    pub last_version: Option<String>,
    /// 이번 출석 알림 끄기 — 해당 출석일(KST, "YYYY-MM-DD")에만 알림을 보내지 않음.
    /// None이면 비활성, 날짜가 현재 출석일과 다르면 자동 무시.
    /// morning_start 기준으로 출석일이 구분되므로 자정~morning_start 사이에는 전날 날짜도 유효.
    #[serde(default, alias = "skip_today")]
    pub skip_attendance: Option<String>,
    /// 일요일(KST) 알림 끄기 (기본 false)
    #[serde(default)]
    pub skip_sunday: bool,
}

fn default_true() -> bool {
    true
}

fn default_notification_interval() -> u32 {
    15
}

fn default_notification_start() -> TimeOfDay {
    TimeOfDay { hour: 9, minute: 0 }
}

fn default_notification_end() -> TimeOfDay {
    TimeOfDay { hour: 1, minute: 0 }
}

const ALLOWED_NOTIFICATION_INTERVAL_MINS: [u32; 6] = [1, 3, 5, 10, 15, 30];

impl TimeOfDay {
    /// 자정 기준 초 단위 변환. 시간 비교·계산에 사용.
    pub fn to_secs(&self) -> i64 {
        (self.hour as i64) * 3600 + (self.minute as i64) * 60
    }
}

pub fn validate_notification_start(hour: u32, minute: u32) -> Result<TimeOfDay, String> {
    if minute != 0 {
        return Err("알림 시작 시각의 분은 0이어야 합니다.".into());
    }
    if !(4..=9).contains(&hour) {
        return Err("알림 시작 시각은 04:00부터 09:00 사이여야 합니다.".into());
    }
    Ok(TimeOfDay { hour, minute })
}

pub fn validate_notification_end(hour: u32, minute: u32) -> Result<TimeOfDay, String> {
    if minute != 0 {
        return Err("알림 종료 시각의 분은 0이어야 합니다.".into());
    }
    if hour > 4 {
        return Err("알림 종료 시각은 00:00부터 04:00 사이여야 합니다.".into());
    }
    Ok(TimeOfDay { hour, minute })
}

pub fn validate_notification_interval(value: u32) -> Result<u32, String> {
    if ALLOWED_NOTIFICATION_INTERVAL_MINS.contains(&value) {
        Ok(value)
    } else {
        Err("알림 간격은 1, 3, 5, 10, 15, 30분 중 하나여야 합니다.".into())
    }
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("jungle-bell").join("config.json"))
}

impl Config {
    /// 설정 로드. 파일이 없거나 파싱 실패 시 기본값 사용.
    pub fn load() -> Self {
        if let Some(path) = config_path() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                match serde_json::from_str::<Config>(&data) {
                    Ok(mut config) => {
                        log::info!("[config] loaded from {}", path.display());
                        if config.normalize_loaded_values() {
                            config.save();
                        }
                        return config;
                    }
                    Err(e) => log::warn!(
                        "[config] 설정 파일({}) 파싱 실패: {}. 기본 설정을 사용합니다.",
                        path.display(),
                        e
                    ),
                }
            } else if path.exists() {
                log::warn!(
                    "[config] 설정 파일({}) 읽기 실패. 기본 설정을 사용합니다.",
                    path.display()
                );
                return Self::default();
            }
        }
        log::info!("[config] using defaults (first launch)");
        Self::default()
    }

    /// 설정을 파일에 저장.
    pub fn save(&self) {
        if let Some(path) = config_path() {
            if let Some(parent) = path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    log::error!("[config] 설정 디렉토리({}) 생성 실패: {}", parent.display(), e);
                    return;
                }
            }
            match serde_json::to_string_pretty(self) {
                Ok(data) => {
                    if let Err(e) = write_file_atomically(&path, data.as_bytes()) {
                        log::error!("[config] 설정 파일({}) 저장 실패: {}", path.display(), e);
                    }
                }
                Err(e) => log::error!("[config] 설정 직렬화 실패: {}", e),
            }
        }
    }

    fn normalize_loaded_values(&mut self) -> bool {
        let mut changed = false;

        if normalize_notification_start(&mut self.notification_start) {
            changed = true;
        }
        if normalize_notification_end(&mut self.notification_end) {
            changed = true;
        }
        if normalize_notification_interval(
            &mut self.start_notification_interval_mins,
            "start_notification_interval_mins",
        ) {
            changed = true;
        }
        if normalize_notification_interval(
            &mut self.end_notification_interval_mins,
            "end_notification_interval_mins",
        ) {
            changed = true;
        }

        changed
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            morning_start: TimeOfDay { hour: 4, minute: 0 },
            morning_end: TimeOfDay { hour: 10, minute: 0 },
            evening_start: TimeOfDay { hour: 23, minute: 0 },
            evening_end: TimeOfDay { hour: 4, minute: 0 },
            auto_update: true,
            auto_start: true,
            start_notification_enabled: true,
            end_notification_enabled: true,
            start_notification_interval_mins: 15,
            end_notification_interval_mins: 15,
            notification_start: TimeOfDay { hour: 9, minute: 0 },
            notification_end: TimeOfDay { hour: 1, minute: 0 },
            debug_mode: false,
            welcome_notification_sent: false,
            last_version: None,
            skip_attendance: None,
            skip_sunday: false,
        }
    }
}

fn normalize_notification_start(time: &mut TimeOfDay) -> bool {
    let original_hour = time.hour;
    let original_minute = time.minute;

    if time.hour < 4 {
        time.hour = 4;
    } else if time.hour > 9 {
        time.hour = 9;
    }
    time.minute = 0;

    let changed = time.hour != original_hour || time.minute != original_minute;
    if changed {
        log::info!(
            "[config] notification_start {:02}:{:02} → {:02}:{:02}로 마이그레이션",
            original_hour,
            original_minute,
            time.hour,
            time.minute
        );
    }
    changed
}

fn normalize_notification_end(time: &mut TimeOfDay) -> bool {
    let original_hour = time.hour;
    let original_minute = time.minute;

    if time.hour == 23 {
        time.hour = 0;
    } else if time.hour > 4 {
        time.hour = 4;
    }
    time.minute = 0;

    let changed = time.hour != original_hour || time.minute != original_minute;
    if changed {
        log::info!(
            "[config] notification_end {:02}:{:02} → {:02}:{:02}로 마이그레이션",
            original_hour,
            original_minute,
            time.hour,
            time.minute
        );
    }
    changed
}

fn normalize_notification_interval(value: &mut u32, field_name: &str) -> bool {
    if ALLOWED_NOTIFICATION_INTERVAL_MINS.contains(value) {
        return false;
    }

    let original = *value;
    *value = nearest_notification_interval(*value);
    log::info!("[config] {} {}분 → {}분으로 마이그레이션", field_name, original, *value);
    true
}

fn nearest_notification_interval(value: u32) -> u32 {
    let mut best = ALLOWED_NOTIFICATION_INTERVAL_MINS[0];
    let mut best_distance = best.abs_diff(value);

    for candidate in ALLOWED_NOTIFICATION_INTERVAL_MINS.iter().copied().skip(1) {
        let distance = candidate.abs_diff(value);
        if distance < best_distance || (distance == best_distance && candidate < best) {
            best = candidate;
            best_distance = distance;
        }
    }

    best
}

fn write_file_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("설정 파일 상위 디렉토리가 없습니다."))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("설정 파일 이름을 확인할 수 없습니다."))?
        .to_string_lossy()
        .into_owned();

    let mut temp_path = None;
    for attempt in 0..32 {
        let candidate = parent.join(format!(".{}.tmp-{}-{}", file_name, std::process::id(), attempt));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                file.write_all(data)?;
                file.sync_all()?;
                drop(file);
                temp_path = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }

    let temp_path = temp_path.ok_or_else(|| std::io::Error::other("임시 설정 파일을 만들지 못했습니다."))?;

    if let Err(e) = replace_file(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    sync_directory(parent)?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(target_os = "windows")]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    unsafe extern "system" {
        fn MoveFileExW(lpExistingFileName: *const u16, lpNewFileName: *const u16, dwFlags: u32) -> i32;
    }

    fn to_wide(path: &Path) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }

    let from_wide = to_wide(from);
    let to_wide = to_wide(to);

    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_notification_times_reject_invalid_values() {
        assert!(validate_notification_start(4, 0).is_ok());
        assert!(validate_notification_end(4, 0).is_ok());
        assert!(validate_notification_start(10, 0).is_err());
        assert!(validate_notification_start(9, 30).is_err());
        assert!(validate_notification_end(5, 0).is_err());
        assert!(validate_notification_end(2, 30).is_err());
    }

    #[test]
    fn validate_notification_interval_rejects_unknown_values() {
        assert_eq!(validate_notification_interval(15).unwrap(), 15);
        assert!(validate_notification_interval(2).is_err());
    }

    #[test]
    fn normalize_loaded_values_clamps_removed_or_invalid_values() {
        let mut config = Config {
            notification_start: TimeOfDay { hour: 10, minute: 30 },
            notification_end: TimeOfDay { hour: 23, minute: 45 },
            start_notification_interval_mins: 2,
            end_notification_interval_mins: 99,
            ..Config::default()
        };

        assert!(config.normalize_loaded_values());
        assert_eq!(config.notification_start.hour, 9);
        assert_eq!(config.notification_start.minute, 0);
        assert_eq!(config.notification_end.hour, 0);
        assert_eq!(config.notification_end.minute, 0);
        assert_eq!(config.start_notification_interval_mins, 1);
        assert_eq!(config.end_notification_interval_mins, 30);
    }
}
