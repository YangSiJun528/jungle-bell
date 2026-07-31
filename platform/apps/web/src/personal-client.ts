import { fetchWithTimeout } from "./fetch-with-timeout";

export interface MealRuleInput {
  readonly enabled: boolean;
  readonly breakfast: boolean;
  readonly lunch: boolean;
  readonly dinner: boolean;
}

export interface MealRuleDto extends MealRuleInput {
  readonly updatedAtEpochMs: number;
}

export interface AttendanceRuleInput {
  readonly enabled: boolean;
  readonly morning: boolean;
  readonly evening: boolean;
}

export interface AttendanceRuleDto extends AttendanceRuleInput {
  readonly updatedAtEpochMs: number;
}

export type ApplianceKind = "washer" | "dryer";

export interface LaundryWatchInput {
  readonly machineId: string;
  readonly appliance: ApplianceKind;
  readonly sessionId: string | null;
  readonly notifyBeforeMinutes: number;
  readonly notifyWhenAvailable: boolean;
}

export interface LaundryWatchDto extends LaundryWatchInput {
  readonly id: string;
  readonly status: "active" | "completed" | "cancelled";
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export interface LaundryQueueInput {
  readonly machineId: string | null;
  readonly appliance: ApplianceKind;
}

export interface LaundryQueueEntryDto extends LaundryQueueInput {
  readonly id: string;
  readonly status: "waiting" | "claimed" | "cancelled" | "expired";
  readonly joinedAtEpochMs: number;
  readonly leftAtEpochMs: number | null;
  readonly position: number | null;
}

export function getMealRule(): Promise<MealRuleDto> {
  return apiRequest("/api/private/meal-rule", parseMealRule);
}

export function putMealRule(input: MealRuleInput): Promise<MealRuleDto> {
  assertMealRuleInput(input);
  return apiRequest("/api/private/meal-rule", parseMealRule, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function getAttendanceRule(): Promise<AttendanceRuleDto> {
  return apiRequest(
    "/api/private/attendance-rule",
    parseAttendanceRule,
  );
}

export function putAttendanceRule(
  input: AttendanceRuleInput,
): Promise<AttendanceRuleDto> {
  assertAttendanceRuleInput(input);
  return apiRequest(
    "/api/private/attendance-rule",
    parseAttendanceRule,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function getLaundryWatches(): Promise<
  readonly LaundryWatchDto[]
> {
  const response = await apiRequest(
    "/api/private/laundry-watches",
    parseLaundryWatchList,
  );
  return response.watches;
}

export function createLaundryWatch(
  input: LaundryWatchInput,
): Promise<LaundryWatchDto> {
  assertLaundryWatchInput(input);
  return apiRequest(
    "/api/private/laundry-watches",
    parseLaundryWatch,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function cancelLaundryWatch(id: string): Promise<void> {
  assertIdentifier(id);
  return apiNoContent(
    `/api/private/laundry-watches/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function getLaundryQueue(): Promise<
  readonly LaundryQueueEntryDto[]
> {
  const response = await apiRequest(
    "/api/private/laundry-queue",
    parseLaundryQueueList,
  );
  return response.entries;
}

export function joinLaundryQueue(
  input: LaundryQueueInput,
): Promise<LaundryQueueEntryDto> {
  assertLaundryQueueInput(input);
  return apiRequest(
    "/api/private/laundry-queue",
    parseLaundryQueueEntry,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function leaveLaundryQueue(id: string): Promise<void> {
  assertIdentifier(id);
  return apiNoContent(
    `/api/private/laundry-queue/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

async function apiRequest<T>(
  path: string,
  parser: (value: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiResponse(path, init);
  if (!response.ok) {
    throw new Error(await errorCode(response));
  }
  if (
    !(response.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("application/json")
  ) {
    throw invalidResponse();
  }
  try {
    return parser(await response.json());
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "API_RESPONSE_INVALID"
    ) {
      throw error;
    }
    throw invalidResponse();
  }
}

async function apiNoContent(
  path: string,
  init: RequestInit,
): Promise<void> {
  const response = await apiResponse(path, init);
  if (!response.ok) {
    throw new Error(await errorCode(response));
  }
  if (response.status !== 204) {
    throw invalidResponse();
  }
}

function apiResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchWithTimeout(path, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

function parseMealRule(value: unknown): MealRuleDto {
  const record = exactRecord(value, [
    "enabled",
    "breakfast",
    "lunch",
    "dinner",
    "updatedAtEpochMs",
  ]);
  const rule = {
    enabled: requiredBoolean(record.enabled),
    breakfast: requiredBoolean(record.breakfast),
    lunch: requiredBoolean(record.lunch),
    dinner: requiredBoolean(record.dinner),
  };
  return {
    ...rule,
    updatedAtEpochMs: epochMilliseconds(record.updatedAtEpochMs),
  };
}

function parseAttendanceRule(value: unknown): AttendanceRuleDto {
  const record = exactRecord(value, [
    "enabled",
    "morning",
    "evening",
    "updatedAtEpochMs",
  ]);
  return {
    enabled: requiredBoolean(record.enabled),
    morning: requiredBoolean(record.morning),
    evening: requiredBoolean(record.evening),
    updatedAtEpochMs: epochMilliseconds(record.updatedAtEpochMs),
  };
}

function parseLaundryWatchList(value: unknown): {
  watches: readonly LaundryWatchDto[];
} {
  const record = exactRecord(value, ["watches"]);
  if (!Array.isArray(record.watches) || record.watches.length > 128) {
    throw invalidResponse();
  }
  return { watches: record.watches.map(parseLaundryWatch) };
}

function parseLaundryWatch(value: unknown): LaundryWatchDto {
  const record = exactRecord(value, [
    "id",
    "machineId",
    "appliance",
    "sessionId",
    "notifyBeforeMinutes",
    "notifyWhenAvailable",
    "status",
    "createdAtEpochMs",
    "updatedAtEpochMs",
  ]);
  const status = record.status;
  if (
    status !== "active" &&
    status !== "completed" &&
    status !== "cancelled"
  ) {
    throw invalidResponse();
  }
  const createdAtEpochMs = epochMilliseconds(record.createdAtEpochMs);
  const updatedAtEpochMs = epochMilliseconds(record.updatedAtEpochMs);
  if (updatedAtEpochMs < createdAtEpochMs) {
    throw invalidResponse();
  }
  return {
    id: identifier(record.id),
    machineId: boundedString(record.machineId, 128),
    appliance: applianceKind(record.appliance),
    sessionId:
      record.sessionId === null
        ? null
        : boundedString(record.sessionId, 256),
    notifyBeforeMinutes: boundedInteger(
      record.notifyBeforeMinutes,
      0,
      180,
    ),
    notifyWhenAvailable: requiredBoolean(record.notifyWhenAvailable),
    status,
    createdAtEpochMs,
    updatedAtEpochMs,
  };
}

function parseLaundryQueueList(value: unknown): {
  entries: readonly LaundryQueueEntryDto[];
} {
  const record = exactRecord(value, ["entries"]);
  if (!Array.isArray(record.entries) || record.entries.length > 32) {
    throw invalidResponse();
  }
  return { entries: record.entries.map(parseLaundryQueueEntry) };
}

function parseLaundryQueueEntry(value: unknown): LaundryQueueEntryDto {
  const record = exactRecord(value, [
    "id",
    "machineId",
    "appliance",
    "status",
    "joinedAtEpochMs",
    "leftAtEpochMs",
    "position",
  ]);
  const status = record.status;
  if (
    status !== "waiting" &&
    status !== "claimed" &&
    status !== "cancelled" &&
    status !== "expired"
  ) {
    throw invalidResponse();
  }
  const joinedAtEpochMs = epochMilliseconds(record.joinedAtEpochMs);
  const leftAtEpochMs =
    record.leftAtEpochMs === null
      ? null
      : epochMilliseconds(record.leftAtEpochMs);
  if (
    (status === "waiting" && leftAtEpochMs !== null) ||
    (status !== "waiting" && leftAtEpochMs === null) ||
    (leftAtEpochMs !== null && leftAtEpochMs < joinedAtEpochMs) ||
    (status === "waiting" && record.position === null) ||
    (status !== "waiting" && record.position !== null)
  ) {
    throw invalidResponse();
  }
  return {
    id: identifier(record.id),
    machineId:
      record.machineId === null
        ? null
        : boundedString(record.machineId, 128),
    appliance: applianceKind(record.appliance),
    status,
    joinedAtEpochMs,
    leftAtEpochMs,
    position:
      status === "waiting"
        ? boundedInteger(record.position, 1, 100_000)
        : null,
  };
}

function assertMealRuleInput(input: MealRuleInput): void {
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.breakfast !== "boolean" ||
    typeof input.lunch !== "boolean" ||
    typeof input.dinner !== "boolean"
  ) {
    throw invalidArgument();
  }
}

function assertAttendanceRuleInput(input: AttendanceRuleInput): void {
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.morning !== "boolean" ||
    typeof input.evening !== "boolean"
  ) {
    throw invalidArgument();
  }
}

function assertLaundryWatchInput(input: LaundryWatchInput): void {
  try {
    boundedString(input.machineId, 128);
    applianceKind(input.appliance);
    if (input.sessionId !== null) {
      boundedString(input.sessionId, 256);
    }
    boundedInteger(input.notifyBeforeMinutes, 0, 180);
    requiredBoolean(input.notifyWhenAvailable);
  } catch {
    throw invalidArgument();
  }
}

function assertLaundryQueueInput(input: LaundryQueueInput): void {
  try {
    if (input.machineId !== null) {
      boundedString(input.machineId, 128);
    }
    applianceKind(input.appliance);
  } catch {
    throw invalidArgument();
  }
}

function assertIdentifier(value: string): void {
  try {
    identifier(value);
  } catch {
    throw invalidArgument();
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw invalidResponse();
  }
  return record;
}

function identifier(value: unknown): string {
  const id = boundedString(value, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) {
    throw invalidResponse();
  }
  return id;
}

function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw invalidResponse();
  }
  return value;
}

function applianceKind(value: unknown): ApplianceKind {
  if (value !== "washer" && value !== "dryer") {
    throw invalidResponse();
  }
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidResponse();
  }
  return value;
}

function epochMilliseconds(value: unknown): number {
  return boundedInteger(value, 0, 8_640_000_000_000_000);
}

async function errorCode(response: Response): Promise<string> {
  try {
    const record = exactRecord(await response.json(), ["error"]);
    if (
      typeof record.error === "string" &&
      /^[A-Z][A-Z0-9_-]{0,127}$/u.test(record.error)
    ) {
      return record.error;
    }
  } catch {
    // The HTTP status is the stable fallback for malformed error bodies.
  }
  return `HTTP_${response.status}`;
}

function invalidArgument(): Error {
  return new Error("API_CLIENT_INVALID_ARGUMENT");
}

function invalidResponse(): Error {
  return new Error("API_RESPONSE_INVALID");
}
