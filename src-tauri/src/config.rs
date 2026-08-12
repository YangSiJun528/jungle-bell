use serde::{Deserialize, Deserializer, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const CURRENT_CONFIG_FILE_NAME: &str = "desktop-settings.json";
const CONFIG_SCHEMA: &str = "jungle-bell.desktop-settings";
const CONFIG_SCHEMA_VERSION: u32 = 3;
const MIN_SUPPORTED_CONFIG_SCHEMA_VERSION: u32 = 3;

pub const MORNING_START_HOUR: u32 = 4;
pub const MORNING_START_MINUTE: u32 = 0;
pub const MORNING_END_HOUR: u32 = 10;
pub const MORNING_END_MINUTE: u32 = 0;
pub const EVENING_START_HOUR: u32 = 23;
pub const EVENING_START_MINUTE: u32 = 0;
pub const EVENING_END_HOUR: u32 = 4;
pub const EVENING_END_MINUTE: u32 = 0;

pub const fn seconds_since_midnight(hour: u32, minute: u32) -> i64 {
    (hour as i64) * 3600 + (minute as i64) * 60
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigDocument {
    schema: String,
    schema_version: u32,
    settings: Config,
}

/// 데스크톱에 영속하는 현재형 사용자 설정.
///
/// 출석 알림, 식단, 세탁 설정은 서버가 소유한다. 이 파일에는 이 PC의
/// 프로세스·업데이트·진단 동작에만 적용되는 설정을 저장한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub auto_start: bool,
    pub auto_update: bool,
    pub usage_analytics: bool,
    pub debug_mode: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub selected_cohort_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            auto_start: false,
            auto_update: true,
            usage_analytics: true,
            debug_mode: false,
            selected_cohort_id: None,
        }
    }
}

fn deserialize_required_nullable<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

pub(crate) fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|path| path.join("jungle-bell").join(CURRENT_CONFIG_FILE_NAME))
}

impl Config {
    pub fn load() -> Self {
        let Some(path) = config_path() else {
            log::warn!("[config] 운영체제 설정 디렉토리를 확인할 수 없어 기본 설정을 사용합니다");
            return Self::default();
        };
        Self::load_from(&path)
    }

    pub(crate) fn load_from(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(data) => match parse_config_document(&data) {
                Ok(config) => config,
                Err(error) => {
                    log::warn!(
                        "[config] 현재 설정 파일({}) 검증 실패: {}. 기본 설정을 사용합니다.",
                        path.display(),
                        error
                    );
                    Self::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                log::warn!(
                    "[config] 현재 설정 파일({}) 읽기 실패: {}. 기본 설정을 사용합니다.",
                    path.display(),
                    error
                );
                Self::default()
            }
        }
    }

    pub(crate) fn save_to(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "설정 파일 상위 디렉토리가 없습니다.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("설정 디렉토리({}) 생성 실패: {error}", parent.display()))?;
        let data = serialize_config_document(self)?;
        write_file_atomically(path, data.as_bytes())
            .map_err(|error| format!("설정 파일({}) 저장 실패: {error}", path.display()))
    }
}

fn serialize_config_document(config: &Config) -> Result<String, String> {
    serde_json::to_string_pretty(&ConfigDocument {
        schema: CONFIG_SCHEMA.to_owned(),
        schema_version: CONFIG_SCHEMA_VERSION,
        settings: config.clone(),
    })
    .map_err(|error| format!("설정 직렬화 실패: {error}"))
}

fn parse_config_document(data: &str) -> Result<Config, String> {
    let document: ConfigDocument = serde_json::from_str(data).map_err(|error| format!("설정 파싱 실패: {error}"))?;
    if document.schema != CONFIG_SCHEMA
        || !(MIN_SUPPORTED_CONFIG_SCHEMA_VERSION..=CONFIG_SCHEMA_VERSION).contains(&document.schema_version)
    {
        return Err("지원하지 않는 설정 스키마입니다.".into());
    }
    validate_selected_cohort_id(document.settings.selected_cohort_id.as_deref())?;
    Ok(document.settings)
}

pub(crate) fn validate_selected_cohort_id(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|value| {
        value.is_empty() || value.trim() != value || value.chars().count() > 128 || value.chars().any(char::is_control)
    }) {
        return Err("잘못된 기수 ID입니다.".into());
    }
    Ok(())
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
        let candidate = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                file.write_all(data)?;
                file.sync_all()?;
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    let temp_path = temp_path.ok_or_else(|| std::io::Error::other("임시 설정 파일을 만들지 못했습니다."))?;
    if let Err(error) = replace_file(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    sync_directory(parent)
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
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    fn to_wide(path: &Path) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }

    let from = to_wide(from);
    let to = to_wide(to);
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
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

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "jungle-bell-config-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn 현재_설정은_데스크톱_서비스와_lms_기수_선택을_직렬화한다() {
        let value: serde_json::Value =
            serde_json::from_str(&serialize_config_document(&Config::default()).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 3,
                "settings": {
                    "autoStart": false,
                    "autoUpdate": true,
                    "usageAnalytics": true,
                    "debugMode": false,
                    "selectedCohortId": null
                }
            })
        );
    }

    #[test]
    fn 현재_설정은_선택한_기수_id를_함께_저장한다() {
        let config = Config {
            selected_cohort_id: Some("cohort-10".into()),
            ..Config::default()
        };
        let serialized = serialize_config_document(&config).unwrap();
        assert_eq!(parse_config_document(&serialized).unwrap(), config);
        assert!(serialized.contains("selectedCohortId"));
    }

    #[test]
    fn 지원하지_않는_버전과_알_수_없는_필드는_거부한다() {
        for invalid in [
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 2,
                "settings": { "autoStart": true }
            }),
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 3,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": true,
                    "usageAnalytics": true,
                    "debugMode": false
                }
            }),
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 3,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": true,
                    "usageAnalytics": true,
                    "debugMode": false,
                    "selectedCohortId": null,
                    "unknown": true
                }
            }),
            serde_json::json!({ "autoStart": true }),
        ] {
            assert!(parse_config_document(&invalid.to_string()).is_err());
        }
    }

    #[test]
    fn 저장_실패는_호출자에게_전달한다() {
        let root = temporary_path("save-error");
        let blocked_parent = root.join("not-a-directory");
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocked_parent, b"file").unwrap();
        let error = Config::default()
            .save_to(&blocked_parent.join("settings.json"))
            .expect_err("상위 경로가 파일이면 실패해야 한다");
        assert!(error.contains("설정 디렉토리"));
        fs::remove_dir_all(root).unwrap();
    }
}
