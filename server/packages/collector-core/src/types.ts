export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const SOURCE_NAMES = ["laundry", "meals-include-pinned", "meals-default"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export type CollectionStatus = "SUCCESS" | "FAILED" | "GAP";

export interface SourceState {
  source: SourceName;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastResponseSha: string | null;
  lastRawKey: string | null;
  lastNormalizedKey: string | null;
  versionFirstSeenAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SourceVersion {
  source: SourceName;
  sha: string;
  firstObservedAt: string;
  rawKey: string;
  normalizedKey: string | null;
}

export interface MinuteObservation {
  source: SourceName;
  minuteEpoch: number;
  scheduledAt: string;
  collectedAt: string;
  status: CollectionStatus;
  versionSha: string | null;
  rawKey: string | null;
  normalizedKey: string | null;
  versionFirstSeenAt: string | null;
  changed: boolean;
  durationMs: number;
  httpStatus: number | null;
  error: string | null;
}

export type LaundryEventType =
  | "STARTED"
  | "STATE_CHANGED"
  | "COUNTDOWN_NORMAL"
  | "ETA_EXTENDED"
  | "ETA_REDUCED"
  | "TOTAL_TIME_ADJUSTED"
  | "PAUSED"
  | "ERROR_ENTERED"
  | "ERROR_CLEARED"
  | "COMPLETED"
  | "STOPPED_UNEXPECTEDLY"
  | "UNKNOWN_STATE";

export interface LaundryEvent {
  id: string;
  machineId: string;
  appliance: "washer" | "dryer";
  sessionId: string | null;
  type: LaundryEventType;
  previousObservedAt: string | null;
  observedAt: string;
  etaDeltaMinutes: number | null;
  previousState: string | null;
  currentState: string;
  detail: Record<string, JsonValue>;
}

export interface CollectionCommit {
  observation: MinuteObservation;
  state: SourceState;
  version?: SourceVersion;
  laundryEvents?: LaundryEvent[];
}

export interface BinaryObject {
  body: Uint8Array;
  contentType: string;
  etag?: string;
}

export interface CollectorStorage {
  readState(source: SourceName): Promise<SourceState | null>;
  readJson<T>(key: string): Promise<T | null>;
  writeJson(key: string, value: unknown): Promise<void>;
  writeRaw(key: string, raw: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  writeBinary(key: string, object: BinaryObject): Promise<void>;
  commit(commit: CollectionCommit): Promise<void>;
}

export interface JsonHttpResponse {
  raw: string;
  value: unknown;
  status: number;
  fetchedAt: string;
  durationMs: number;
}

export interface BinaryHttpResponse {
  body: Uint8Array;
  contentType: string;
  status: number;
  fetchedAt: string;
  durationMs: number;
}

export interface CollectorUrls {
  laundry: string;
  mealsIncludePinned: string;
  mealsDefault: string;
  mealsPage: string;
}

export interface CollectorOptions {
  urls: CollectorUrls;
  requestTimeoutMs: number;
  requestRetries: number;
  userAgent: string;
  lgRunStates?: readonly string[];
}

export interface CollectAllResult {
  scheduledAt: string;
  results: Array<{
    source: SourceName;
    status: CollectionStatus;
    changed: boolean;
    sha: string | null;
    error: string | null;
  }>;
}
