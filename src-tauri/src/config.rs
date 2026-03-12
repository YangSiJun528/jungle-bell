/// 시각 값 (시 + 분). 스케줄 경계 설정에 사용.
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
pub struct Config {
    /// 하루 시작 / 체크인 가능 시작 (기본 04:00)
    pub morning_start: TimeOfDay,
    /// 체크인 목표 마감 (기본 10:00, 이후는 지각)
    pub morning_end: TimeOfDay,
    /// 체크아웃 가능 시작 (기본 23:00)
    pub evening_start: TimeOfDay,
    /// 체크아웃 마감 / 하루 끝 (기본 다음 날 04:00)
    pub evening_end: TimeOfDay,
}

impl Config {
    /// 설정 로드. 현재는 하드코딩, 추후 파일 기반으로 변경 예정.
    pub fn load() -> Self {
        Self {
            morning_start: TimeOfDay { hour: 4, minute: 0 },
            morning_end: TimeOfDay { hour: 10, minute: 0 },
            evening_start: TimeOfDay { hour: 23, minute: 0 },
            evening_end: TimeOfDay { hour: 4, minute: 0 },
        }
    }
}
