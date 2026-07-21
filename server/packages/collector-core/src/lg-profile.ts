export const LG_THINQ_PROFILE_REFERENCE = {
  repository: "https://github.com/thinq-connect/pythinqconnect",
  washerProfile: "thinqconnect/devices/washer.py",
  dryerProfile: "thinqconnect/devices/dryer.py",
  note: "LG ThinQ enum values are model-specific and supplied by each device profile.",
} as const;

// Fallback for aggregated APIs that do not expose the source device profile.
// Deployments can extend this set through CollectorOptions.lgRunStates.
export const LG_RUN_STATE_BASELINE = [
  "POWER_OFF",
  "INITIAL",
  "RESERVED",
  "DETECTING",
  "DISPENSING",
  "SOAKING",
  "WASHING",
  "RINSING",
  "SPINNING",
  "RUNNING",
  "DRYING",
  "COOLING",
  "REFRESHING",
  "WRINKLE_CARE",
  "PAUSE",
  "END",
  "ERROR",
] as const;

export type KnownLgRunState = (typeof LG_RUN_STATE_BASELINE)[number];

export interface NormalizedEnum {
  code: string;
  raw: string | null;
  known: boolean;
  labelKo: string;
}

export function lgRunStateLabelKo(code: string): string {
  const labels: Record<string, string> = {
    POWER_OFF: "전원 꺼짐",
    INITIAL: "사용 가능",
    RESERVED: "예약됨",
    DETECTING: "세탁량 감지 중",
    DISPENSING: "세제 투입 중",
    SOAKING: "불림 중",
    WASHING: "세탁 중",
    RINSING: "헹굼 중",
    SPINNING: "탈수 중",
    RUNNING: "작동 중",
    DRYING: "건조 중",
    COOLING: "식힘 중",
    REFRESHING: "리프레시 중",
    WRINKLE_CARE: "구김 방지 중",
    PAUSE: "일시 정지",
    END: "완료",
    ERROR: "오류",
    UNKNOWN: "알 수 없음",
  };
  return labels[code] ?? "알 수 없음";
}

export function normalizeLgEnum(value: string, knownValues: ReadonlySet<string>): NormalizedEnum {
  if (knownValues.has(value)) return { code: value, raw: null, known: true, labelKo: lgRunStateLabelKo(value) };
  return { code: "UNKNOWN", raw: value, known: false, labelKo: lgRunStateLabelKo("UNKNOWN") };
}
