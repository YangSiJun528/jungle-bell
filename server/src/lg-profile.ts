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
}

export function normalizeLgEnum(value: string, knownValues: ReadonlySet<string>): NormalizedEnum {
  if (knownValues.has(value)) return { code: value, raw: null, known: true };
  return { code: "UNKNOWN", raw: value, known: false };
}
