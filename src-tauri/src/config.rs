use serde::{Deserialize, Serialize};
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
    /// 알림 활성화 여부 (기본 true)
    #[serde(default = "default_true")]
    pub notification_enabled: bool,
    /// 알림 간격 (분, 기본 5)
    #[serde(default = "default_notification_interval")]
    pub notification_interval_mins: u32,
    /// 알림 시작 시각 — 이 시각 이전에는 아침 알림을 보내지 않음 (기본 09:00)
    #[serde(default = "default_notification_start")]
    pub notification_start: TimeOfDay,
    /// 알림 종료 시각 — 이 시각 이후에는 저녁 알림을 보내지 않음 (기본 01:00)
    #[serde(default = "default_notification_end")]
    pub notification_end: TimeOfDay,
    /// 디버그 모드 — 활성화 시 상세 로그 출력 (기본 false)
    #[serde(default)]
    pub debug_mode: bool,
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

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("jungle-bell").join("config.json"))
}

impl Config {
    /// 설정 로드. 파일이 없거나 파싱 실패 시 기본값 사용.
    pub fn load() -> Self {
        if let Some(path) = config_path() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                match serde_json::from_str::<Config>(&data) {
                    Ok(config) => {
                        log::info!("[config] loaded from {}", path.display());
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
            }
        }
        log::info!("[config] using defaults");
        Self::default()
    }

    /// 설정을 파일에 저장.
    pub fn save(&self) {
        if let Some(path) = config_path() {
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::error!("[config] 설정 디렉토리({}) 생성 실패: {}", parent.display(), e);
                    return;
                }
            }
            match serde_json::to_string_pretty(self) {
                Ok(data) => {
                    if let Err(e) = std::fs::write(&path, data) {
                        log::error!("[config] 설정 파일({}) 저장 실패: {}", path.display(), e);
                    }
                }
                Err(e) => log::error!("[config] 설정 직렬화 실패: {}", e),
            }
        }
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
            notification_enabled: true,
            notification_interval_mins: 15,
            notification_start: TimeOfDay { hour: 9, minute: 0 },
            notification_end: TimeOfDay { hour: 1, minute: 0 },
            debug_mode: false,
        }
    }
}
