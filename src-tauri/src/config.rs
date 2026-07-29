use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

/// 시각 값 (시 + 분). 스케줄 경계 설정에 사용.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeOfDay {
    pub hour: u32,
    pub minute: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaundryApplianceKind {
    Washer,
    Dryer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaundryWatch {
    pub machine_id: String,
    pub appliance: LaundryApplianceKind,
    pub session_id: String,
    pub notify_before_mins: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaundryTerminalStatus {
    Completed,
    Error,
    NeedsCheck,
    Replaced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaundryTerminalActivity {
    pub id: String,
    pub watch: LaundryWatch,
    pub status: LaundryTerminalStatus,
    pub finished_at: i64,
}

/// 출석 체크 시간대 설정.
///
/// 하루가 다음 시간대로 나뉨:
///   morning_start ~ morning_end  : 학습 시작(체크인) 목표 시간  (04:00 ~ 10:00)
///   morning_end   ~ evening_start: 학습 중, 액션 없음          (10:00 ~ 23:00)
///   evening_start ~ evening_end  : 학습 종료(체크아웃) 시간     (23:00 ~ 04:00)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// 하루 시작 / 체크인 가능 시작
    pub morning_start: TimeOfDay,
    /// 체크인 목표 마감. 이후는 지각으로 처리.
    pub morning_end: TimeOfDay,
    /// 체크아웃 가능 시작
    pub evening_start: TimeOfDay,
    /// 체크아웃 마감 / 하루 끝
    pub evening_end: TimeOfDay,
    /// 시스템 시작 시 앱 자동 실행 여부
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// 시작 출석 알림 활성화 여부
    #[serde(default = "default_true")]
    pub start_notification_enabled: bool,
    /// 종료 출석 알림 활성화 여부
    #[serde(default = "default_true")]
    pub end_notification_enabled: bool,
    /// 알림 시작 시각 — 이 시각 이전에는 아침 알림을 보내지 않음
    #[serde(default = "default_notification_start")]
    pub notification_start: TimeOfDay,
    /// 알림 종료 시각 — 이 시각 이후에는 저녁 알림을 보내지 않음
    #[serde(default = "default_notification_end")]
    pub notification_end: TimeOfDay,
    /// 디버그 모드 — 활성화 시 상세 로그 출력
    #[serde(default)]
    pub debug_mode: bool,
    /// 사용 통계 전송 여부
    #[serde(default = "default_true")]
    pub usage_analytics_enabled: bool,
    /// 트레이 패널 D-Day 표시 여부
    #[serde(default = "default_true")]
    pub show_dday: bool,
    /// macOS Dock 또는 Windows 작업 표시줄에 앱 아이콘을 표시할지 여부
    #[serde(default = "default_true")]
    pub show_app_icon: bool,
    /// 환영 알림 발송 완료 여부
    /// 기존 config에 필드가 없으면 false → 신규/기존 사용자 모두 한 번 알림 수신.
    #[serde(default)]
    pub welcome_notification_sent: bool,
    /// 온보딩 완료 여부
    #[serde(default)]
    pub onboarding_completed: bool,
    /// 마지막으로 실행된 앱 버전. 업데이트 완료 알림 판단에 사용.
    /// None이면 첫 설치 (환영 알림 대상).
    #[serde(default)]
    pub last_version: Option<String>,
    /// 이번 출석 알림 끄기 — 해당 출석일(KST, "YYYY-MM-DD")에만 알림을 보내지 않음.
    /// None이면 비활성, 날짜가 현재 출석일과 다르면 자동 무시.
    /// morning_start 기준으로 출석일이 구분되므로 자정~morning_start 사이에는 전날 날짜도 유효.
    #[serde(default, alias = "skip_today")]
    pub skip_attendance: Option<String>,
    /// 일요일(KST) 알림 끄기
    #[serde(default)]
    pub skip_sunday: bool,
    /// 출석을 확인할 기수 ID. None이면 현재 활성 기수를 자동 선택한다.
    #[serde(default)]
    pub selected_cohort_id: Option<String>,
    /// 새 식단이 게시되면 홈에 표시하고 알림을 받을지 여부.
    #[serde(default = "default_true")]
    pub meal_subscription_enabled: bool,
    /// 홈에서 추적하고 종료 임박·완료 알림을 받을 세탁 작업.
    #[serde(default)]
    pub laundry_watch: Option<LaundryWatch>,
    /// 추적은 끝났지만 사용자가 아직 확인·제거하지 않은 세탁 작업.
    #[serde(default)]
    pub laundry_terminal_activities: Vec<LaundryTerminalActivity>,
}

fn default_true() -> bool {
    true
}

fn default_notification_start() -> TimeOfDay {
    TimeOfDay { hour: 9, minute: 0 }
}

fn default_notification_end() -> TimeOfDay {
    TimeOfDay { hour: 4, minute: 0 }
}

pub const ALLOWED_LAUNDRY_NOTICE_MINS: [u32; 6] = [1, 3, 5, 10, 15, 30];

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

pub fn validate_laundry_watch(watch: &LaundryWatch) -> Result<(), String> {
    fn validate_text(value: &str, label: &str, max_len: usize) -> Result<(), String> {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.chars().count() > max_len || trimmed.chars().any(char::is_control) {
            return Err(format!("잘못된 {label}입니다."));
        }
        Ok(())
    }

    validate_text(&watch.machine_id, "세탁기 ID", 80)?;
    validate_text(&watch.session_id, "세탁 세션 ID", 240)?;
    if !ALLOWED_LAUNDRY_NOTICE_MINS.contains(&watch.notify_before_mins) {
        return Err("세탁 종료 전 알림은 1, 3, 5, 10, 15, 30분 중 하나여야 합니다.".into());
    }
    Ok(())
}

pub fn validate_laundry_terminal_activity(activity: &LaundryTerminalActivity) -> Result<(), String> {
    validate_laundry_watch(&activity.watch)?;
    validate_laundry_terminal_activity_id(&activity.id)?;
    if activity.finished_at <= 0 {
        return Err("잘못된 세탁 종료 시각입니다.".into());
    }
    Ok(())
}

pub fn validate_laundry_terminal_activity_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed != id || trimmed.chars().count() > 512 || trimmed.chars().any(char::is_control) {
        return Err("잘못된 세탁 종료 항목 ID입니다.".into());
    }
    Ok(())
}

pub fn validate_cohort_id(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed != value || trimmed.chars().count() > 128 || trimmed.chars().any(char::is_control)
    {
        return Err("잘못된 기수 ID입니다.".into());
    }
    Ok(())
}

pub(crate) fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("jungle-bell").join("config.json"))
}

impl Config {
    /// 설정 로드. 파일이 없거나 파싱 실패 시 기본값 사용.
    pub fn load() -> Self {
        if let Some(path) = config_path() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                let had_onboarding_completed = config_data_has_field(&data, "onboarding_completed");
                match serde_json::from_str::<Config>(&data) {
                    Ok(mut config) => {
                        log::info!("[config] loaded from {}", path.display());
                        let mut changed = false;
                        if !had_onboarding_completed {
                            config.onboarding_completed = true;
                            changed = true;
                            log::info!("[config] 기존 설정 파일에 온보딩 필드가 없어 완료 상태로 마이그레이션");
                        }
                        if config.normalize_loaded_values() {
                            changed = true;
                        }
                        if changed {
                            if let Err(error) = config.save() {
                                log::error!("[config] 마이그레이션 결과 저장 실패: {error}");
                            }
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

    /// 기본 설정 경로에 저장한다. 실패는 호출자에게 전달한다.
    pub fn save(&self) -> Result<(), String> {
        let path = config_path().ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        self.save_to(&path)
    }

    /// 지정한 경로에 원자적으로 저장한다.
    pub(crate) fn save_to(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "설정 파일 상위 디렉토리가 없습니다.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("설정 디렉토리({}) 생성 실패: {error}", parent.display()))?;
        let data = serde_json::to_string_pretty(self).map_err(|error| format!("설정 직렬화 실패: {error}"))?;
        write_file_atomically(path, data.as_bytes())
            .map_err(|error| format!("설정 파일({}) 저장 실패: {error}", path.display()))
    }

    pub fn dismiss_laundry_terminal_activity(&mut self, activity_id: &str) -> bool {
        let original_len = self.laundry_terminal_activities.len();
        self.laundry_terminal_activities
            .retain(|activity| activity.id != activity_id);
        self.laundry_terminal_activities.len() != original_len
    }

    fn normalize_loaded_values(&mut self) -> bool {
        let mut changed = false;

        if normalize_notification_start(&mut self.notification_start) {
            changed = true;
        }
        if normalize_notification_end(&mut self.notification_end) {
            changed = true;
        }
        if self
            .laundry_watch
            .as_ref()
            .is_some_and(|watch| validate_laundry_watch(watch).is_err())
        {
            log::warn!("[config] 잘못된 세탁 추적 설정을 제거합니다");
            self.laundry_watch = None;
            changed = true;
        }
        let original_terminal_count = self.laundry_terminal_activities.len();
        let mut terminal_ids = BTreeSet::new();
        self.laundry_terminal_activities.retain(|activity| {
            validate_laundry_terminal_activity(activity).is_ok() && terminal_ids.insert(activity.id.clone())
        });
        if self.laundry_terminal_activities.len() != original_terminal_count {
            log::warn!("[config] 잘못되거나 중복된 세탁 종료 항목을 제거합니다");
            changed = true;
        }
        if self
            .selected_cohort_id
            .as_deref()
            .is_some_and(|cohort_id| validate_cohort_id(cohort_id).is_err())
        {
            log::warn!("[config] 잘못된 기수 선택 설정을 제거합니다");
            self.selected_cohort_id = None;
            changed = true;
        }

        changed
    }
}

fn config_data_has_field(data: &str, field_name: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .and_then(|value| value.as_object().map(|object| object.contains_key(field_name)))
        .unwrap_or(false)
}

impl Default for Config {
    fn default() -> Self {
        Self {
            morning_start: TimeOfDay { hour: 4, minute: 0 },
            morning_end: TimeOfDay { hour: 10, minute: 0 },
            evening_start: TimeOfDay { hour: 23, minute: 0 },
            evening_end: TimeOfDay { hour: 4, minute: 0 },
            auto_start: true,
            start_notification_enabled: true,
            end_notification_enabled: true,
            notification_start: TimeOfDay { hour: 9, minute: 0 },
            notification_end: TimeOfDay { hour: 4, minute: 0 },
            debug_mode: false,
            usage_analytics_enabled: true,
            show_dday: true,
            show_app_icon: true,
            welcome_notification_sent: false,
            onboarding_completed: false,
            last_version: None,
            skip_attendance: None,
            skip_sunday: false,
            selected_cohort_id: None,
            meal_subscription_enabled: true,
            laundry_watch: None,
            laundry_terminal_activities: Vec::new(),
        }
    }
}

fn normalize_notification_start(time: &mut TimeOfDay) -> bool {
    let original_hour = time.hour;
    let original_minute = time.minute;

    time.hour = time.hour.clamp(4, 9);
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

pub(crate) fn write_file_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
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
    fn 출석_반복_간격은_사용자_설정으로_저장하지_않는다() {
        let value = serde_json::to_value(Config::default()).unwrap();
        let object = value.as_object().unwrap();

        assert!(!object.contains_key("start_notification_interval_mins"));
        assert!(!object.contains_key("end_notification_interval_mins"));
    }

    #[test]
    fn normalize_loaded_values_clamps_removed_or_invalid_values() {
        let mut config = Config {
            notification_start: TimeOfDay { hour: 10, minute: 30 },
            notification_end: TimeOfDay { hour: 23, minute: 45 },
            ..Config::default()
        };

        assert!(config.normalize_loaded_values());
        assert_eq!(config.notification_start.hour, 9);
        assert_eq!(config.notification_start.minute, 0);
        assert_eq!(config.notification_end.hour, 0);
        assert_eq!(config.notification_end.minute, 0);
    }

    #[test]
    fn dday_표시는_기본적으로_켜져있다() {
        assert!(Config::default().show_dday);
    }

    #[test]
    fn 앱_아이콘_표시는_기본적으로_켜져있다() {
        assert!(Config::default().show_app_icon);
    }

    #[test]
    fn 기존_config도_앱_아이콘_표시를_기본값으로_사용한다() {
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value.as_object_mut().unwrap().remove("show_app_icon");

        let config: Config = serde_json::from_value(value).unwrap();

        assert!(config.show_app_icon);
    }

    #[test]
    fn 기존_알림_표시_방식은_읽을수_있지만_다시_저장하지_않는다() {
        let mut legacy = serde_json::to_value(Config::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .insert("notification_delivery".into(), serde_json::json!("overlay"));
        let migrated: Config = serde_json::from_value(legacy).unwrap();
        let persisted = serde_json::to_value(migrated).unwrap();

        assert!(!persisted.as_object().unwrap().contains_key("notification_delivery"));
    }

    #[test]
    fn 새_식단_알림은_기본적으로_켜지고_세탁_추적은_선택전까지_비활성화된다() {
        let config = Config::default();

        assert!(config.meal_subscription_enabled);
        assert!(config.laundry_watch.is_none());
        assert!(config.laundry_terminal_activities.is_empty());
    }

    #[test]
    fn 종료된_세탁_항목이_없는_기존_config도_빈_목록으로_읽는다() {
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value.as_object_mut().unwrap().remove("laundry_terminal_activities");

        let config: Config = serde_json::from_value(value).unwrap();

        assert!(config.laundry_terminal_activities.is_empty());
    }

    #[test]
    fn 세탁_종료_항목은_지정된_id만_제거한다() {
        let watched = LaundryWatch {
            machine_id: "tower6".into(),
            appliance: LaundryApplianceKind::Washer,
            session_id: "session-1".into(),
            notify_before_mins: 5,
        };
        let first = LaundryTerminalActivity {
            id: "activity-1".into(),
            watch: watched.clone(),
            status: LaundryTerminalStatus::Completed,
            finished_at: 1_785_118_700_000,
        };
        let second = LaundryTerminalActivity {
            id: "activity-2".into(),
            watch: LaundryWatch {
                appliance: LaundryApplianceKind::Dryer,
                session_id: "session-2".into(),
                ..watched
            },
            status: LaundryTerminalStatus::Error,
            finished_at: 1_785_122_300_000,
        };
        let mut config = Config {
            laundry_terminal_activities: vec![first, second.clone()],
            ..Config::default()
        };

        assert!(config.dismiss_laundry_terminal_activity("activity-1"));
        assert_eq!(config.laundry_terminal_activities, vec![second]);
        assert!(!config.dismiss_laundry_terminal_activity("missing"));
    }

    #[test]
    fn 세탁_종료_항목은_설정_파일에_저장되어_재시작후에도_복구된다() {
        let root = std::env::temp_dir().join(format!(
            "jungle-bell-laundry-terminal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let path = root.join("config.json");
        let activity = LaundryTerminalActivity {
            id: "activity-persisted".into(),
            watch: LaundryWatch {
                machine_id: "tower6".into(),
                appliance: LaundryApplianceKind::Washer,
                session_id: "session-1".into(),
                notify_before_mins: 5,
            },
            status: LaundryTerminalStatus::Completed,
            finished_at: 1_785_118_700_000,
        };
        let config = Config {
            laundry_terminal_activities: vec![activity.clone()],
            ..Config::default()
        };

        config.save_to(&path).unwrap();
        let restored: Config = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(restored.laundry_terminal_activities, vec![activity]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 식단_알림_필드가_없는_기존_config도_기본값을_사용한다() {
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value.as_object_mut().unwrap().remove("meal_subscription_enabled");

        let config: Config = serde_json::from_value(value).unwrap();

        assert!(config.meal_subscription_enabled);
    }

    #[test]
    fn 세탁_추적은_기기와_세션과_종료전_알림_분을_검증한다() {
        let valid = LaundryWatch {
            machine_id: "워시타워_6".into(),
            appliance: LaundryApplianceKind::Washer,
            session_id: "tower6:washer:cycle:42".into(),
            notify_before_mins: 5,
        };
        assert!(validate_laundry_watch(&valid).is_ok());

        let invalid_minutes = LaundryWatch {
            notify_before_mins: 2,
            ..valid.clone()
        };
        assert!(validate_laundry_watch(&invalid_minutes).is_err());

        let invalid_machine = LaundryWatch {
            machine_id: "tower6\nforged".into(),
            ..valid
        };
        assert!(validate_laundry_watch(&invalid_machine).is_err());
    }

    #[test]
    fn 기수_선택은_기본적으로_자동이며_유효한_id만_저장한다() {
        assert!(Config::default().selected_cohort_id.is_none());
        assert!(validate_cohort_id("cohort-2026-1").is_ok());
        assert!(validate_cohort_id("").is_err());
        assert!(validate_cohort_id("cohort\nforged").is_err());
    }

    #[test]
    fn config_data_has_field_detects_existing_onboarding_flag() {
        assert!(config_data_has_field(
            r#"{"onboarding_completed":false}"#,
            "onboarding_completed"
        ));
        assert!(!config_data_has_field(r#"{"auto_start":true}"#, "onboarding_completed"));
        assert!(!config_data_has_field("not json", "onboarding_completed"));
    }

    #[test]
    fn save_to_propagates_parent_directory_errors() {
        let root = std::env::temp_dir().join(format!("jungle-bell-config-save-error-{}", std::process::id()));
        let blocked_parent = root.join("not-a-directory");
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocked_parent, b"file").unwrap();

        let error = Config::default()
            .save_to(&blocked_parent.join("config.json"))
            .expect_err("상위 경로가 파일이면 저장 실패가 호출자에게 전달되어야 한다");

        assert!(error.contains("설정 디렉토리"));
        fs::remove_dir_all(root).unwrap();
    }
}
