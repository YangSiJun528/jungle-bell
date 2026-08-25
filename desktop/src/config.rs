use serde::{Deserialize, Deserializer, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const CURRENT_CONFIG_FILE_NAME: &str = "desktop-settings.json";
const CONFIG_SCHEMA: &str = "jungle-bell.desktop-settings";
const CONFIG_SCHEMA_VERSION: u32 = 5;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigEnvelope {
    schema: String,
    schema_version: u32,
    settings: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyConfigV3 {
    auto_start: bool,
    auto_update: bool,
    usage_analytics: bool,
    debug_mode: bool,
    #[serde(deserialize_with = "deserialize_required_nullable_string")]
    selected_cohort_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyConfigV4 {
    auto_start: bool,
    auto_update: bool,
    debug_mode: bool,
    #[serde(deserialize_with = "deserialize_required_nullable_string")]
    selected_cohort_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigProvenance {
    Missing,
    V3,
    V4,
    V5,
    Invalid,
    Unavailable,
}

impl ConfigProvenance {
    fn requires_rewrite(self) -> bool {
        matches!(self, Self::V3 | Self::V4)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadedConfig {
    pub(crate) config: Config,
    pub(crate) provenance: ConfigProvenance,
}

impl LoadedConfig {
    fn fallback(provenance: ConfigProvenance) -> Self {
        Self {
            config: Config::default(),
            provenance,
        }
    }

    pub(crate) fn startup_usage_analytics(&self, clean_new_installation: bool) -> Option<bool> {
        if self.provenance == ConfigProvenance::Missing && clean_new_installation {
            Some(true)
        } else {
            self.config.usage_analytics
        }
    }

    pub(crate) fn runtime_usage_analytics(&self, resolved: Option<bool>) -> Option<bool> {
        if matches!(
            self.provenance,
            ConfigProvenance::Invalid | ConfigProvenance::Unavailable
        ) {
            Some(false)
        } else {
            resolved
        }
    }
}

/// 데스크톱에 영속하는 현재형 사용자 설정.
///
/// 출석 알림, 식단, 세탁 설정은 서버가 소유한다. 이 파일에는 이 PC의
/// 프로세스·업데이트·진단 동작과 서버에 동기화할 통계 선택을 저장한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub auto_start: bool,
    pub auto_update: bool,
    #[serde(deserialize_with = "deserialize_required_nullable_bool")]
    pub usage_analytics: Option<bool>,
    pub debug_mode: bool,
    #[serde(deserialize_with = "deserialize_required_nullable_string")]
    pub selected_cohort_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            auto_start: false,
            auto_update: true,
            usage_analytics: None,
            debug_mode: false,
            selected_cohort_id: None,
        }
    }
}

fn deserialize_required_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

fn deserialize_required_nullable_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<bool>::deserialize(deserializer)
}

pub(crate) fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|path| path.join("jungle-bell").join(CURRENT_CONFIG_FILE_NAME))
}

impl Config {
    pub(crate) fn load() -> LoadedConfig {
        let Some(path) = config_path() else {
            log::warn!("[config] 운영체제 설정 디렉토리를 확인할 수 없어 기본 설정을 사용합니다");
            return LoadedConfig::fallback(ConfigProvenance::Unavailable);
        };
        Self::load_from(&path)
    }

    pub(crate) fn load_from(path: &Path) -> LoadedConfig {
        Self::load_from_with_save(path, |config, path| config.save_to(path))
    }

    fn load_from_with_save(path: &Path, save: impl FnOnce(&Config, &Path) -> Result<(), String>) -> LoadedConfig {
        match fs::read_to_string(path) {
            Ok(data) => match parse_config_document(&data) {
                Ok((config, provenance)) => {
                    if provenance.requires_rewrite() {
                        if let Err(error) = save(&config, path) {
                            log::warn!("[config] 이전 설정을 적용했지만 v5 파일 재작성에 실패했습니다: {error}");
                        }
                    }
                    LoadedConfig { config, provenance }
                }
                Err(error) => {
                    log::warn!(
                        "[config] 현재 설정 파일({}) 검증 실패: {}. 기본 설정을 사용합니다.",
                        path.display(),
                        error
                    );
                    LoadedConfig::fallback(ConfigProvenance::Invalid)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                LoadedConfig::fallback(ConfigProvenance::Missing)
            }
            Err(error) => {
                log::warn!(
                    "[config] 현재 설정 파일({}) 읽기 실패: {}. 기본 설정을 사용합니다.",
                    path.display(),
                    error
                );
                LoadedConfig::fallback(ConfigProvenance::Unavailable)
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

fn parse_config_document(data: &str) -> Result<(Config, ConfigProvenance), String> {
    let envelope: ConfigEnvelope = serde_json::from_str(data).map_err(|error| format!("설정 파싱 실패: {error}"))?;
    if envelope.schema != CONFIG_SCHEMA
        || !(MIN_SUPPORTED_CONFIG_SCHEMA_VERSION..=CONFIG_SCHEMA_VERSION).contains(&envelope.schema_version)
    {
        return Err("지원하지 않는 설정 스키마입니다.".into());
    }
    let (config, provenance) = match envelope.schema_version {
        3 => {
            let legacy: LegacyConfigV3 =
                serde_json::from_value(envelope.settings).map_err(|error| format!("v3 설정 파싱 실패: {error}"))?;
            (
                Config {
                    auto_start: legacy.auto_start,
                    auto_update: legacy.auto_update,
                    // v3의 기본값은 true였으므로 true만으로는 명시적 동의를 증명할 수 없다.
                    // 기본값과 구분되는 false만 거부 의사로 승계한다.
                    usage_analytics: (!legacy.usage_analytics).then_some(false),
                    debug_mode: legacy.debug_mode,
                    selected_cohort_id: legacy.selected_cohort_id,
                },
                ConfigProvenance::V3,
            )
        }
        4 => {
            let legacy: LegacyConfigV4 =
                serde_json::from_value(envelope.settings).map_err(|error| format!("v4 설정 파싱 실패: {error}"))?;
            (
                Config {
                    auto_start: legacy.auto_start,
                    auto_update: legacy.auto_update,
                    usage_analytics: None,
                    debug_mode: legacy.debug_mode,
                    selected_cohort_id: legacy.selected_cohort_id,
                },
                ConfigProvenance::V4,
            )
        }
        5 => (
            serde_json::from_value(envelope.settings).map_err(|error| format!("v5 설정 파싱 실패: {error}"))?,
            ConfigProvenance::V5,
        ),
        _ => return Err("지원하지 않는 설정 스키마입니다.".into()),
    };
    validate_selected_cohort_id(config.selected_cohort_id.as_deref())?;
    Ok((config, provenance))
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
                "schemaVersion": 5,
                "settings": {
                    "autoStart": false,
                    "autoUpdate": true,
                    "usageAnalytics": null,
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
        assert_eq!(
            parse_config_document(&serialized).unwrap(),
            (config, ConfigProvenance::V5)
        );
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
                "schemaVersion": 5,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": true,
                    "usageAnalytics": null,
                    "debugMode": false
                }
            }),
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 5,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": true,
                    "usageAnalytics": null,
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
    fn v3_설정은_통계_거부를_보존해_v5로_원자적_마이그레이션한다() {
        let path = temporary_path("v3-migration");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 3,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": false,
                    "usageAnalytics": false,
                    "debugMode": true,
                    "selectedCohortId": "cohort-10"
                }
            })
            .to_string(),
        )
        .unwrap();

        let loaded = Config::load_from(&path);

        assert_eq!(loaded.provenance, ConfigProvenance::V3);
        assert!(loaded.config.auto_start);
        assert!(!loaded.config.auto_update);
        assert_eq!(loaded.config.usage_analytics, Some(false));
        assert!(loaded.config.debug_mode);
        assert_eq!(loaded.config.selected_cohort_id.as_deref(), Some("cohort-10"));
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(rewritten.contains("\"schemaVersion\": 5"));
        assert!(rewritten.contains("\"usageAnalytics\": false"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn v3의_기본_허용값은_명시적_동의로_보지_않는다() {
        let document = serde_json::json!({
            "schema": "jungle-bell.desktop-settings",
            "schemaVersion": 3,
            "settings": {
                "autoStart": false,
                "autoUpdate": true,
                "usageAnalytics": true,
                "debugMode": false,
                "selectedCohortId": null
            }
        });

        let (config, provenance) = parse_config_document(&document.to_string()).unwrap();

        assert_eq!(provenance, ConfigProvenance::V3);
        assert_eq!(config.usage_analytics, None);
    }

    #[test]
    fn v4_사용자는_통계_결정을_복원할_수_없어_undecided로_마이그레이션한다() {
        let path = temporary_path("v4-migration");
        let document = serde_json::json!({
            "schema": "jungle-bell.desktop-settings",
            "schemaVersion": 4,
            "settings": {
                "autoStart": false,
                "autoUpdate": true,
                "debugMode": false,
                "selectedCohortId": null
            }
        });
        fs::write(&path, document.to_string()).unwrap();

        let loaded = Config::load_from(&path);

        assert_eq!(loaded.provenance, ConfigProvenance::V4);
        assert_eq!(loaded.config.usage_analytics, None);
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(rewritten.contains("\"schemaVersion\": 5"));
        assert!(rewritten.contains("\"usageAnalytics\": null"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 누락과_잘못된_설정은_구분하고_통계를_기본_허용하지_않는다() {
        let missing = Config::load_from(&temporary_path("missing"));
        assert_eq!(missing.provenance, ConfigProvenance::Missing);
        assert_eq!(missing.config.usage_analytics, None);
        assert_eq!(missing.startup_usage_analytics(false), None);
        assert_eq!(missing.startup_usage_analytics(true), Some(true));

        let invalid_path = temporary_path("invalid");
        fs::write(&invalid_path, "not-json").unwrap();
        let invalid = Config::load_from(&invalid_path);
        assert_eq!(invalid.provenance, ConfigProvenance::Invalid);
        assert_eq!(invalid.config.usage_analytics, None);
        assert_eq!(invalid.startup_usage_analytics(true), None);
        assert_eq!(invalid.runtime_usage_analytics(None), Some(false));
        assert_eq!(fs::read_to_string(&invalid_path).unwrap(), "not-json");
        fs::remove_file(invalid_path).unwrap();

        let unavailable_path = temporary_path("unavailable");
        fs::create_dir(&unavailable_path).unwrap();
        let unavailable = Config::load_from(&unavailable_path);
        assert_eq!(unavailable.provenance, ConfigProvenance::Unavailable);
        assert_eq!(unavailable.startup_usage_analytics(true), None);
        assert_eq!(unavailable.runtime_usage_analytics(None), Some(false));
        fs::remove_dir(unavailable_path).unwrap();
    }

    #[test]
    fn v3_재작성_실패여도_읽은_설정은_유지한다() {
        let path = temporary_path("v3-rewrite-failure");
        fs::write(
            &path,
            serde_json::json!({
                "schema": "jungle-bell.desktop-settings",
                "schemaVersion": 3,
                "settings": {
                    "autoStart": true,
                    "autoUpdate": false,
                    "usageAnalytics": false,
                    "debugMode": true,
                    "selectedCohortId": null
                }
            })
            .to_string(),
        )
        .unwrap();

        let loaded = Config::load_from_with_save(&path, |_, _| Err("injected write failure".into()));

        assert_eq!(loaded.provenance, ConfigProvenance::V3);
        assert!(loaded.config.auto_start);
        assert!(!loaded.config.auto_update);
        assert_eq!(loaded.config.usage_analytics, Some(false));
        assert!(loaded.config.debug_mode);
        fs::remove_file(path).unwrap();
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
