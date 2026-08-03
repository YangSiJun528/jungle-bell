import { fetchWithTimeout } from "./fetch-with-timeout";

export type CampusKind = "laundry" | "meals";

export interface CampusEnvelope<T> {
  readonly kind: CampusKind;
  readonly data: T | null;
  readonly etag: string | null;
  readonly savedAtEpochMs: number | null;
  readonly lastCheckedAtEpochMs: number | null;
  readonly stale: boolean;
  readonly lastError: string | null;
}

export interface LaundryProjection {
  readonly asOf?: string;
  readonly remainingMinutes: number | null;
  readonly status: string;
  readonly estimated: boolean;
}

export interface LaundryAppliance {
  readonly appliance: "washer" | "dryer";
  readonly observedAt?: string;
  readonly operationalStatus: string;
  readonly remainingMinutes: number | null;
  readonly totalMinutes?: number;
  readonly startedAt?: string;
  readonly estimatedFinishAt?: string | null;
  readonly sessionId: string | null;
  readonly projection: LaundryProjection;
}

export interface LaundryMachine {
  readonly id: string;
  readonly washer: LaundryAppliance | null;
  readonly dryer: LaundryAppliance | null;
}

export interface LaundrySnapshot {
  readonly asOf: string;
  readonly final: boolean;
  readonly quality: {
    readonly collection: string;
    readonly sourceFreshness: string;
    readonly lastCheckedAt: string | null;
  };
  readonly machines: readonly LaundryMachine[];
}

export interface MealPost {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly text: string;
  readonly publishedAt: string | null;
  readonly permalink: string | null;
}

export interface MealsSnapshot {
  readonly asOf: string;
  readonly lastCheckedAt: string | null;
  readonly data: {
    readonly dailyMenus: readonly MealPost[];
    readonly pinnedMenus: readonly MealPost[];
    readonly recentMenus: readonly MealPost[];
  };
}

export function getPublicLaundry(): Promise<
  CampusEnvelope<LaundrySnapshot>
> {
  return getCampusEnvelope(
    "/api/public/campus/laundry",
    "laundry",
    parseLaundrySnapshot,
  );
}

export function getPublicMeals(): Promise<CampusEnvelope<MealsSnapshot>> {
  return getCampusEnvelope(
    "/api/public/campus/meals",
    "meals",
    parseMealsSnapshot,
  );
}

async function getCampusEnvelope<T>(
  path: string,
  expectedKind: CampusKind,
  parseData: (value: unknown) => T,
): Promise<CampusEnvelope<T>> {
  const response = await fetchWithTimeout(path, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw invalidResponse();
  }
  return parseCampusEnvelope(await response.json(), expectedKind, parseData);
}

function parseCampusEnvelope<T>(
  value: unknown,
  expectedKind: CampusKind,
  parseData: (value: unknown) => T,
): CampusEnvelope<T> {
  const record = exactRecord(value, [
    "kind",
    "data",
    "etag",
    "savedAtEpochMs",
    "lastCheckedAtEpochMs",
    "stale",
    "lastError",
  ]);
  if (
    record.kind !== expectedKind ||
    typeof record.stale !== "boolean"
  ) {
    throw invalidResponse();
  }
  const data = record.data === null ? null : parseData(record.data);
  const etag =
    record.etag === null ? null : boundedString(record.etag, 256);
  const savedAtEpochMs = nullableEpochMilliseconds(record.savedAtEpochMs);
  const lastCheckedAtEpochMs = nullableEpochMilliseconds(
    record.lastCheckedAtEpochMs,
  );
  const lastError =
    record.lastError === null
      ? null
      : boundedString(record.lastError, 256);
  if (
    (data === null && savedAtEpochMs !== null) ||
    (data !== null && savedAtEpochMs === null)
  ) {
    throw invalidResponse();
  }
  return {
    kind: expectedKind,
    data,
    etag,
    savedAtEpochMs,
    lastCheckedAtEpochMs,
    stale: record.stale,
    lastError,
  };
}

function parseLaundrySnapshot(value: unknown): LaundrySnapshot {
  const record = requiredRecord(value);
  const quality = requiredRecord(record.quality);
  if (!Array.isArray(record.machines) || record.machines.length > 64) {
    throw invalidResponse();
  }
  return {
    asOf: isoTimestamp(record.asOf),
    final: requiredBoolean(record.final),
    quality: {
      collection: uppercaseCode(quality.collection),
      sourceFreshness: uppercaseCode(quality.sourceFreshness),
      lastCheckedAt:
        quality.lastCheckedAt === null
          ? null
          : isoTimestamp(quality.lastCheckedAt),
    },
    machines: record.machines.map(parseLaundryMachine),
  };
}

function parseLaundryMachine(value: unknown): LaundryMachine {
  const record = requiredRecord(value);
  const id = boundedString(record.id, 128);
  const washer =
    record.washer === null
      ? null
      : parseLaundryAppliance(record.washer, "washer");
  const dryer =
    record.dryer === null
      ? null
      : parseLaundryAppliance(record.dryer, "dryer");
  return { id, washer, dryer };
}

function parseLaundryAppliance(
  value: unknown,
  expectedAppliance: "washer" | "dryer",
): LaundryAppliance {
  const record = requiredRecord(value);
  if (record.appliance !== expectedAppliance) {
    throw invalidResponse();
  }
  const projection = requiredRecord(record.projection);
  const observedAt = optionalIsoTimestamp(record.observedAt);
  const totalMinutes = optionalNonNegativeSafeInteger(record.totalMinutes);
  const startedAt = optionalIsoTimestamp(record.startedAt);
  const estimatedFinishAt = optionalNullableIsoTimestamp(
    record.estimatedFinishAt,
  );
  const projectionAsOf = optionalIsoTimestamp(projection.asOf);
  return {
    appliance: expectedAppliance,
    ...(observedAt === undefined ? {} : { observedAt }),
    operationalStatus: uppercaseCode(record.operationalStatus),
    remainingMinutes: nullableNonNegativeInteger(record.remainingMinutes),
    ...(totalMinutes === undefined ? {} : { totalMinutes }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(estimatedFinishAt === undefined ? {} : { estimatedFinishAt }),
    sessionId:
      record.sessionId === null
        ? null
        : boundedString(record.sessionId, 256),
    projection: {
      ...(projectionAsOf === undefined ? {} : { asOf: projectionAsOf }),
      remainingMinutes: nullableNonNegativeInteger(
        projection.remainingMinutes,
      ),
      status: uppercaseCode(projection.status),
      estimated: requiredBoolean(projection.estimated),
    },
  };
}

function parseMealsSnapshot(value: unknown): MealsSnapshot {
  const record = requiredRecord(value);
  const data = requiredRecord(record.data);
  return {
    asOf: isoTimestamp(record.asOf),
    lastCheckedAt:
      record.lastCheckedAt === null
        ? null
        : isoTimestamp(record.lastCheckedAt),
    data: {
      dailyMenus: parseMealPosts(data.dailyMenus),
      pinnedMenus: parseMealPosts(data.pinnedMenus),
      recentMenus: parseMealPosts(data.recentMenus),
    },
  };
}

function parseMealPosts(value: unknown): readonly MealPost[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw invalidResponse();
  }
  return value.map(parseMealPost);
}

function parseMealPost(value: unknown): MealPost {
  const record = requiredRecord(value);
  return {
    id: boundedString(record.id, 128),
    kind: uppercaseCode(record.kind),
    title:
      record.title === null
        ? null
        : boundedStringAllowEmpty(record.title, 1_024),
    text: boundedStringAllowEmpty(record.text, 100_000),
    publishedAt:
      record.publishedAt === null
        ? null
        : isoTimestamp(record.publishedAt),
    permalink:
      record.permalink === null ? null : safeHttpUrl(record.permalink),
  };
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = requiredRecord(value);
  const keys = Object.keys(record);
  if (
    keys.length !== allowedKeys.length ||
    !keys.every((key) => allowedKeys.includes(key))
  ) {
    throw invalidResponse();
  }
  return record;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw invalidResponse();
  }
  return value;
}

function boundedStringAllowEmpty(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalidResponse();
  }
  return value;
}

function uppercaseCode(value: unknown): string {
  const code = boundedString(value, 64);
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(code)) {
    throw invalidResponse();
  }
  return code;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function nullableEpochMilliseconds(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 10_000
  ) {
    throw invalidResponse();
  }
  return value;
}

function optionalNonNegativeSafeInteger(
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  return value;
}

function optionalIsoTimestamp(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isoTimestampWithOffset(value);
}

function optionalNullableIsoTimestamp(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return isoTimestampWithOffset(value);
}

function isoTimestampWithOffset(value: unknown): string {
  const timestamp = boundedString(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
    timestamp,
  );
  if (match === null || !Number.isFinite(Date.parse(timestamp))) {
    throw invalidResponse();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw invalidResponse();
  }
  return timestamp;
}

function isoTimestamp(value: unknown): string {
  const timestamp = boundedString(value, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw invalidResponse();
  }
  return timestamp;
}

function safeHttpUrl(value: unknown): string {
  const url = boundedString(value, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidResponse();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalidResponse();
  }
  return url;
}

function invalidResponse(): Error {
  return new Error("API_RESPONSE_INVALID");
}
