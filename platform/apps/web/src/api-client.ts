import { fetchWithTimeout } from "./fetch-with-timeout";

export interface PairingClaim {
  readonly claimId: string;
  readonly claimReceipt: string;
  readonly status: "awaiting-desktop-approval";
}

export type DesktopAuthState =
  | "disconnected"
  | "unknown"
  | "connected"
  | "expiring"
  | "expired";

export interface DesktopAuthStatus {
  readonly state: DesktopAuthState;
  readonly desktopId: string | null;
  readonly lastVerifiedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly health: DesktopDeviceHealth | null;
}

export interface MobilePairingCreated {
  readonly pairingId: string;
  readonly qrPayload: string;
  readonly manualCode: string;
  readonly expiresAt: string;
}

export interface MobilePairingStatus {
  readonly status: "pending" | "claimed" | "approved" | "completed";
  readonly claim: {
    readonly claimId: string;
    readonly deviceLabel: string;
    readonly confirmationCode: string;
  } | null;
}

export interface BrowserPushSubscriptionDto {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: {
    readonly auth: string;
    readonly p256dh: string;
  };
}

export interface MobileDeviceSessionDto {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly scopes: readonly (
    | "attendance:read"
    | "notifications:receive"
    | "preferences:read"
    | "preferences:write"
  )[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly pushEnabled: boolean;
  readonly revokedAt: string | null;
  readonly status: "active" | "revoked" | "expired";
}

export type AttendanceCohortStatus =
  | "active"
  | "upcoming"
  | "ended"
  | "none"
  | "unknown";

export type DesktopLmsSessionState =
  | "unknown"
  | "connected"
  | "login-required";

export type DesktopDeviceHealth = "unknown" | "online" | "offline";

export interface DesktopDeviceDto {
  readonly id: string;
  readonly lastVerifiedAt: string;
  readonly lastSeenAt: string | null;
  readonly lmsSessionState: DesktopLmsSessionState;
  readonly health: DesktopDeviceHealth;
  readonly appVersion: string | null;
}

export interface AttendanceSnapshotDto {
  readonly attendanceDate: string;
  readonly cohortId: string | null;
  readonly cohortStatus: AttendanceCohortStatus;
  readonly cohortStartDate: string | null;
  readonly cohortEndDate: string | null;
  readonly morningChecked: boolean;
  readonly eveningChecked: boolean;
  readonly collectedAt: string;
  readonly sourceDeviceId: string;
  readonly version: number;
}

export type AttendanceDto =
  | {
      readonly status: "available";
      readonly freshness: "fresh" | "stale";
      readonly lastSyncedAt: string;
      readonly snapshot: AttendanceSnapshotDto;
    }
  | {
      readonly status: "unavailable";
      readonly freshness: "missing";
      readonly lastSyncedAt: null;
      readonly snapshot: null;
    };

export type AttendanceDashboardResult =
  | {
      readonly state: "loaded";
      readonly attendance: AttendanceDto;
      readonly devices: readonly DesktopDeviceDto[];
    }
  | {
      readonly state: "auth-required";
    };

const PAIRING_ID_PATTERN = /^jbc_[0-9a-f]{32}$/;
const PAIRING_PROOF_PATTERN = /^jbp_[0-9a-f]{64}$/;
const CLAIM_RECEIPT_PATTERN = /^jbcr_[0-9a-f]{64}$/;
const PUSH_SUBSCRIPTION_ID_PATTERN = /^jbps_[0-9a-f]{64}$/;
const MANUAL_PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const MOBILE_INSTALLATION_ID_PATTERN = /^jbmi_[0-9a-f]{32}$/;
const MOBILE_SESSION_ID_PATTERN = /^jbsi_[0-9a-f]{32}$/;
const MOBILE_DEVICE_ID_PATTERN = /^jbd_[0-9a-f]{32}$/;
const PAIRING_CONFIRMATION_CODE_PATTERN = /^[0-9A-F]{4}$/;

async function apiResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchWithTimeout(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

async function apiRequest<T>(
  path: string,
  parser: (value: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiResponse(path, init);
  await ensureSuccessful(response);
  if (response.status === 204) {
    throw invalidResponse();
  }
  return parser(await readJson(response));
}

async function apiNoContent(
  path: string,
  init: RequestInit,
): Promise<void> {
  const response = await apiResponse(path, init);
  await ensureSuccessful(response);
  if (response.status !== 204) {
    throw invalidResponse();
  }
}

export function claimPairing(input: {
  pairingId: string;
  challenge: string;
  deviceLabel: string;
  installationId: string;
}): Promise<PairingClaim> {
  assertPairingId(input.pairingId);
  assertMobileInstallationId(input.installationId);
  return apiRequest(
    `/api/pairings/${encodeURIComponent(input.pairingId)}/claims`,
    parsePairingClaim,
    {
      method: "POST",
      body: JSON.stringify({
        challenge: input.challenge,
        deviceLabel: input.deviceLabel,
        installationId: input.installationId,
      }),
    },
  );
}

export function claimPairingByManualCode(input: {
  manualCode: string;
  deviceLabel: string;
  installationId: string;
}): Promise<PairingClaim> {
  const manualCode = normalizeManualPairingCode(input.manualCode);
  assertMobileInstallationId(input.installationId);
  return apiRequest("/api/pairing-claims", parsePairingClaim, {
    method: "POST",
    body: JSON.stringify({
      manualCode,
      deviceLabel: input.deviceLabel,
      installationId: input.installationId,
    }),
  });
}

export async function completePairing(
  pairingId: string,
  claim: PairingClaim,
): Promise<"waiting" | "completed"> {
  assertPairingId(pairingId);
  const response = await apiResponse(
    `/api/pairings/${encodeURIComponent(pairingId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        claimId: claim.claimId,
        claimReceipt: claim.claimReceipt,
      }),
    },
  );
  if (response.status === 409) {
    const code = await readErrorCode(response);
    if (code === "PAIRING_NOT_APPROVED") {
      return "waiting";
    }
    throw new Error(code ?? "HTTP_409");
  }
  await ensureSuccessful(response);
  if (response.status === 204) {
    return "completed";
  }
  throw invalidResponse();
}

export async function getDesktopAuthStatus(): Promise<DesktopAuthStatus> {
  const response = await apiResponse("/api/private/desktop/status");
  if (response.status === 401) {
    return disconnectedStatus();
  }
  await ensureSuccessful(response);
  if (response.status === 204) {
    throw invalidResponse();
  }
  return parseDesktopAuthStatus(await readJson(response));
}

export function getDesktopAttendanceDashboard(): Promise<
  AttendanceDashboardResult
> {
  return getAttendanceDashboard(
    "/api/private/desktop/dashboard",
    parseDesktopAttendanceDashboard,
  );
}

export function getCompanionAttendanceDashboard(): Promise<
  AttendanceDashboardResult
> {
  return getAttendanceDashboard(
    "/api/private/dashboard",
    parseCompanionAttendanceDashboard,
  );
}

export function disconnectLms(): Promise<void> {
  return apiNoContent("/api/private/desktop/session", { method: "DELETE" });
}

export function getMobileDeviceSessions(): Promise<{
  readonly sessions: readonly MobileDeviceSessionDto[];
}> {
  return apiRequest(
    "/api/private/desktop/mobile-sessions",
    parseMobileDeviceSessions,
  );
}

export function revokeMobileDeviceSession(sessionId: string): Promise<void> {
  assertMobileSessionId(sessionId);
  return apiNoContent(
    `/api/private/desktop/mobile-sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function disconnectMobileDeviceSession(): Promise<void> {
  return apiNoContent("/api/private/mobile/session", {
    method: "DELETE",
  });
}

export function createMobilePairing(): Promise<MobilePairingCreated> {
  return apiRequest("/api/pairings", parseMobilePairingCreated, {
    method: "POST",
  });
}

export function getMobilePairingStatus(
  pairingId: string,
): Promise<MobilePairingStatus> {
  assertPairingId(pairingId);
  return apiRequest(
    `/api/pairings/${encodeURIComponent(pairingId)}`,
    parseMobilePairingStatus,
  );
}

export function approveMobilePairing(
  pairingId: string,
  claimId: string,
): Promise<void> {
  assertPairingId(pairingId);
  assertPairingId(claimId);
  return apiNoContent(
    `/api/pairings/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ claimId }),
    },
  );
}

export function getVapidPublicKey(): Promise<{ publicKey: string }> {
  return apiRequest("/api/push/vapid-public-key", parseVapidPublicKey);
}

export function registerPushSubscription(
  subscription: BrowserPushSubscriptionDto,
): Promise<{ subscriptionId: string }> {
  return apiRequest(
    "/api/push/subscriptions",
    parsePushSubscriptionRegistration,
    {
      method: "PUT",
      body: JSON.stringify(subscription),
    },
  );
}

export function revokePushSubscription(
  subscriptionId: string,
): Promise<void> {
  return apiNoContent(
    `/api/push/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" },
  );
}

export function sendServerPushTest(): Promise<{
  results: readonly { status: string }[];
}> {
  return apiRequest("/api/push/test", parsePushTestResult, {
    method: "POST",
  });
}

function parsePairingClaim(value: unknown): PairingClaim {
  const record = exactRecord(value, [
    "claimId",
    "claimReceipt",
    "status",
  ]);
  const claimId = pairingId(record.claimId);
  const claimReceipt = requiredString(record.claimReceipt);
  if (
    !CLAIM_RECEIPT_PATTERN.test(claimReceipt) ||
    record.status !== "awaiting-desktop-approval"
  ) {
    throw invalidResponse();
  }
  return {
    claimId,
    claimReceipt,
    status: "awaiting-desktop-approval",
  };
}

function parseDesktopAuthStatus(value: unknown): DesktopAuthStatus {
  const record = exactRecord(value, ["authenticated", "user", "desktop"]);
  if (record.authenticated !== true) {
    throw invalidResponse();
  }
  const user = exactRecord(record.user, ["id"]);
  boundedTrimmedString(user.id, 128);
  const desktop = parseDesktopDevice(record.desktop);
  return {
    state:
      desktop.lmsSessionState === "login-required"
        ? "expired"
        : desktop.lmsSessionState,
    desktopId: desktop.id,
    lastVerifiedAt: desktop.lastVerifiedAt,
    lastSeenAt: desktop.lastSeenAt,
    health: desktop.health,
  };
}

async function getAttendanceDashboard(
  path: string,
  parser: (value: unknown) => {
    attendance: AttendanceDto;
    devices: readonly DesktopDeviceDto[];
  },
): Promise<AttendanceDashboardResult> {
  const response = await apiResponse(path);
  if (response.status === 401) {
    return { state: "auth-required" };
  }
  await ensureSuccessful(response);
  if (response.status === 204) {
    throw invalidResponse();
  }
  const dashboard = parser(await readJson(response));
  return { state: "loaded", ...dashboard };
}

function parseDesktopAttendanceDashboard(value: unknown): {
  attendance: AttendanceDto;
  devices: readonly DesktopDeviceDto[];
} {
  const record = exactRecord(value, ["desktop", "devices", "attendance"]);
  const desktop = exactRecord(record.desktop, ["id"]);
  boundedTrimmedString(desktop.id, 128);
  return {
    attendance: parseAttendance(record.attendance),
    devices: parseDesktopDevices(record.devices),
  };
}

function parseCompanionAttendanceDashboard(value: unknown): {
  attendance: AttendanceDto;
  devices: readonly DesktopDeviceDto[];
} {
  const record = exactRecord(value, ["device", "devices", "attendance"]);
  const device = exactRecord(record.device, ["id", "label"]);
  boundedTrimmedString(device.id, 128);
  boundedTrimmedString(device.label, 80);
  return {
    attendance: parseAttendance(record.attendance),
    devices: parseDesktopDevices(record.devices),
  };
}

function parseAttendance(value: unknown): AttendanceDto {
  const record = exactRecord(value, [
    "status",
    "freshness",
    "lastSyncedAt",
    "snapshot",
  ]);

  if (record.status === "unavailable") {
    if (
      record.freshness !== "missing" ||
      record.lastSyncedAt !== null ||
      record.snapshot !== null
    ) {
      throw invalidResponse();
    }
    return {
      status: "unavailable",
      freshness: "missing",
      lastSyncedAt: null,
      snapshot: null,
    };
  }
  if (
    record.status !== "available" ||
    (record.freshness !== "fresh" && record.freshness !== "stale") ||
    record.snapshot === null
  ) {
    throw invalidResponse();
  }
  const snapshot = parseAttendanceSnapshot(record.snapshot);
  const lastSyncedAt = isoTimestamp(record.lastSyncedAt);
  if (lastSyncedAt !== snapshot.collectedAt) {
    throw invalidResponse();
  }
  return {
    status: "available",
    freshness: record.freshness,
    lastSyncedAt,
    snapshot,
  };
}

function parseAttendanceSnapshot(value: unknown): AttendanceSnapshotDto {
  const record = exactRecord(value, [
    "attendanceDate",
    "cohortId",
    "cohortStatus",
    "cohortStartDate",
    "cohortEndDate",
    "morningChecked",
    "eveningChecked",
    "collectedAt",
    "sourceDeviceId",
    "version",
  ]);
  const attendanceDate = isoDate(record.attendanceDate);
  const cohortId =
    record.cohortId === null
      ? null
      : boundedTrimmedString(record.cohortId, 256);
  const cohortStatus = attendanceCohortStatus(record.cohortStatus);
  const cohortStartDate = nullableIsoDate(record.cohortStartDate);
  const cohortEndDate = nullableIsoDate(record.cohortEndDate);
  if (
    typeof record.morningChecked !== "boolean" ||
    typeof record.eveningChecked !== "boolean" ||
    (cohortStartDate !== null &&
      cohortEndDate !== null &&
      cohortStartDate > cohortEndDate) ||
    (cohortStatus === "active" &&
      (cohortId === null || cohortStartDate === null)) ||
    (cohortStatus !== "active" && cohortId !== null) ||
    ((cohortStatus === "none" || cohortStatus === "unknown") &&
      (cohortStartDate !== null || cohortEndDate !== null)) ||
    (cohortStatus === "ended" && cohortEndDate === null) ||
    (cohortStatus !== "active" &&
      (record.morningChecked || record.eveningChecked))
  ) {
    throw invalidResponse();
  }
  return {
    attendanceDate,
    cohortId,
    cohortStatus,
    cohortStartDate,
    cohortEndDate,
    morningChecked: record.morningChecked,
    eveningChecked: record.eveningChecked,
    collectedAt: isoTimestamp(record.collectedAt),
    sourceDeviceId: boundedTrimmedString(record.sourceDeviceId, 128),
    version: nonNegativeSafeInteger(record.version),
  };
}

function parseDesktopDevices(value: unknown): readonly DesktopDeviceDto[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw invalidResponse();
  }
  return value.map(parseDesktopDevice);
}

function parseDesktopDevice(value: unknown): DesktopDeviceDto {
  const record = exactRecord(value, [
    "id",
    "lastVerifiedAt",
    "lastSeenAt",
    "lmsSessionState",
    "health",
    "appVersion",
  ]);
  const lmsSessionState = record.lmsSessionState;
  if (
    lmsSessionState !== "unknown" &&
    lmsSessionState !== "connected" &&
    lmsSessionState !== "login-required"
  ) {
    throw invalidResponse();
  }
  const health = record.health;
  if (
    health !== "unknown" &&
    health !== "online" &&
    health !== "offline"
  ) {
    throw invalidResponse();
  }
  return {
    id: boundedTrimmedString(record.id, 128),
    lastVerifiedAt: isoTimestamp(record.lastVerifiedAt),
    lastSeenAt: nullableIsoTimestamp(record.lastSeenAt),
    lmsSessionState,
    health,
    appVersion:
      record.appVersion === null
        ? null
        : boundedTrimmedString(record.appVersion, 64),
  };
}

function parseMobilePairingCreated(value: unknown): MobilePairingCreated {
  const record = exactRecord(value, [
    "pairingId",
    "qrPayload",
    "manualCode",
    "expiresAt",
  ]);
  const pairingIdValue = pairingId(record.pairingId);
  const qrPayload = requiredString(record.qrPayload);
  const parsedQr = parsePairingUrl(qrPayload);
  const fragment = new URLSearchParams(parsedQr.hash.slice(1));
  const fragmentKeys = [...fragment.keys()];
  if (
    parsedQr.pathname !== "/pair" ||
    parsedQr.search !== "" ||
    fragmentKeys.length !== 2 ||
    !fragmentKeys.includes("pairing") ||
    !fragmentKeys.includes("challenge") ||
    fragment.get("pairing") !== pairingIdValue ||
    !PAIRING_PROOF_PATTERN.test(fragment.get("challenge") ?? "")
  ) {
    throw invalidResponse();
  }
  return {
    pairingId: pairingIdValue,
    qrPayload,
    manualCode: strictManualPairingCode(record.manualCode),
    expiresAt: timestampString(record.expiresAt),
  };
}

function parseMobilePairingStatus(value: unknown): MobilePairingStatus {
  const record = exactRecord(value, ["status", "claim"]);
  const status = record.status;
  if (
    status !== "pending" &&
    status !== "claimed" &&
    status !== "approved" &&
    status !== "completed"
  ) {
    throw invalidResponse();
  }
  if (record.claim === null) {
    if (status === "claimed") {
      throw invalidResponse();
    }
    return { status, claim: null };
  }
  if (status !== "claimed") {
    throw invalidResponse();
  }
  const claim = exactRecord(record.claim, [
    "claimId",
    "deviceLabel",
    "confirmationCode",
  ]);
  const confirmationCode = requiredString(claim.confirmationCode);
  if (!PAIRING_CONFIRMATION_CODE_PATTERN.test(confirmationCode)) {
    throw invalidResponse();
  }
  return {
    status,
    claim: {
      claimId: pairingId(claim.claimId),
      deviceLabel: boundedTrimmedString(claim.deviceLabel, 80),
      confirmationCode,
    },
  };
}

function parseVapidPublicKey(value: unknown): { publicKey: string } {
  const record = exactRecord(value, ["publicKey"]);
  const publicKey = requiredString(record.publicKey);
  if (publicKey.length > 512) {
    throw invalidResponse();
  }
  return { publicKey };
}

function parsePushSubscriptionRegistration(value: unknown): {
  subscriptionId: string;
} {
  const record = exactRecord(value, ["subscriptionId"]);
  const subscriptionId = requiredString(record.subscriptionId);
  if (!PUSH_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    throw invalidResponse();
  }
  return { subscriptionId };
}

function parseMobileDeviceSessions(value: unknown): {
  readonly sessions: readonly MobileDeviceSessionDto[];
} {
  const record = exactRecord(value, ["sessions"]);
  if (!Array.isArray(record.sessions) || record.sessions.length > 128) {
    throw invalidResponse();
  }
  return {
    sessions: record.sessions.map(parseMobileDeviceSession),
  };
}

function parseMobileDeviceSession(value: unknown): MobileDeviceSessionDto {
  const record = exactRecord(value, [
    "sessionId",
    "deviceId",
    "deviceLabel",
    "scopes",
    "createdAt",
    "expiresAt",
    "lastSeenAt",
    "pushEnabled",
    "revokedAt",
    "status",
  ]);
  const sessionId = requiredString(record.sessionId);
  const deviceId = requiredString(record.deviceId);
  if (
    !MOBILE_SESSION_ID_PATTERN.test(sessionId) ||
    !MOBILE_DEVICE_ID_PATTERN.test(deviceId) ||
    !Array.isArray(record.scopes) ||
    record.scopes.length > 4 ||
    new Set(record.scopes).size !== record.scopes.length
  ) {
    throw invalidResponse();
  }
  const scopes = record.scopes.map(mobileDeviceScope);
  const status = record.status;
  if (
    status !== "active" &&
    status !== "revoked" &&
    status !== "expired"
  ) {
    throw invalidResponse();
  }
  const createdAt = isoTimestamp(record.createdAt);
  const expiresAt = isoTimestamp(record.expiresAt);
  const lastSeenAt = isoTimestamp(record.lastSeenAt);
  const revokedAt = nullableIsoTimestamp(record.revokedAt);
  if (
    expiresAt <= createdAt ||
    lastSeenAt < createdAt ||
    lastSeenAt >= expiresAt ||
    typeof record.pushEnabled !== "boolean" ||
    (status === "active" && revokedAt !== null) ||
    (status === "revoked" && revokedAt === null) ||
    (revokedAt !== null && revokedAt < createdAt)
  ) {
    throw invalidResponse();
  }
  return {
    sessionId,
    deviceId,
    deviceLabel: boundedTrimmedString(record.deviceLabel, 80),
    scopes,
    createdAt,
    expiresAt,
    lastSeenAt,
    pushEnabled: record.pushEnabled,
    revokedAt,
    status,
  };
}

function mobileDeviceScope(value: unknown): MobileDeviceSessionDto["scopes"][number] {
  if (
    value !== "attendance:read" &&
    value !== "notifications:receive" &&
    value !== "preferences:read" &&
    value !== "preferences:write"
  ) {
    throw invalidResponse();
  }
  return value;
}

function parsePushTestResult(value: unknown): {
  results: readonly { status: string }[];
} {
  const record = exactRecord(value, ["results"]);
  if (!Array.isArray(record.results) || record.results.length > 64) {
    throw invalidResponse();
  }
  return {
    results: record.results.map((result) => ({
      status: parsePushDeliveryResult(result),
    })),
  };
}

function parsePushDeliveryResult(value: unknown): string {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw invalidResponse();
  }
  switch (value.status) {
    case "duplicate":
    case "subscription-inactive":
      exactRecord(value, ["status"]);
      return value.status;
    case "delivered": {
      const record = exactRecord(value, ["status", "statusCode"]);
      httpStatus(record.statusCode);
      return value.status;
    }
    case "subscription-revoked": {
      const record = exactRecord(value, ["status", "statusCode"]);
      if (record.statusCode !== 404 && record.statusCode !== 410) {
        throw invalidResponse();
      }
      return value.status;
    }
    case "failed": {
      const record = exactRecord(value, [
        "status",
        "statusCode",
        "retryable",
      ]);
      if (
        (record.statusCode !== null &&
          !isHttpStatus(record.statusCode)) ||
        typeof record.retryable !== "boolean"
      ) {
        throw invalidResponse();
      }
      return value.status;
    }
    default:
      throw invalidResponse();
  }
}

async function ensureSuccessful(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const code = await readErrorCode(response);
  throw new Error(code ?? `HTTP_${response.status}`);
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const record = exactRecord(await response.json(), ["error"]);
    if (
      typeof record.error === "string" &&
      record.error.length >= 1 &&
      record.error.length <= 128
    ) {
      return record.error;
    }
  } catch {
    // The HTTP status remains the stable fallback for malformed error bodies.
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse();
  }
}

function disconnectedStatus(): DesktopAuthStatus {
  return {
    state: "disconnected",
    desktopId: null,
    lastVerifiedAt: null,
    lastSeenAt: null,
    health: null,
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw invalidResponse();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw invalidResponse();
  }
  return value;
}

function boundedTrimmedString(value: unknown, maximum: number): string {
  const parsed = requiredString(value);
  if (parsed.length > maximum || parsed.trim() !== parsed) {
    throw invalidResponse();
  }
  return parsed;
}

function attendanceCohortStatus(value: unknown): AttendanceCohortStatus {
  if (
    value !== "active" &&
    value !== "upcoming" &&
    value !== "ended" &&
    value !== "none" &&
    value !== "unknown"
  ) {
    throw invalidResponse();
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  return value;
}

function isoDate(value: unknown): string {
  const date = boundedTrimmedString(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw invalidResponse();
  }
  try {
    if (
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      date
    ) {
      throw invalidResponse();
    }
  } catch {
    throw invalidResponse();
  }
  return date;
}

function nullableIsoDate(value: unknown): string | null {
  return value === null ? null : isoDate(value);
}

function isoTimestamp(value: unknown): string {
  const timestamp = timestampString(value);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      throw invalidResponse();
    }
  } catch {
    throw invalidResponse();
  }
  return timestamp;
}

function nullableIsoTimestamp(value: unknown): string | null {
  return value === null ? null : isoTimestamp(value);
}

function pairingId(value: unknown): string {
  const identifier = requiredString(value);
  if (!PAIRING_ID_PATTERN.test(identifier)) {
    throw invalidResponse();
  }
  return identifier;
}

function assertPairingId(value: string): void {
  if (!PAIRING_ID_PATTERN.test(value)) {
    throw new Error("API_CLIENT_INVALID_ARGUMENT");
  }
}

function assertMobileInstallationId(value: string): void {
  if (!MOBILE_INSTALLATION_ID_PATTERN.test(value)) {
    throw new Error("API_CLIENT_INVALID_ARGUMENT");
  }
}

function assertMobileSessionId(value: string): void {
  if (!MOBILE_SESSION_ID_PATTERN.test(value)) {
    throw new Error("API_CLIENT_INVALID_ARGUMENT");
  }
}

function strictManualPairingCode(value: unknown): string {
  const manualCode = requiredString(value);
  if (!MANUAL_PAIRING_CODE_PATTERN.test(manualCode)) {
    throw invalidResponse();
  }
  return manualCode;
}

function normalizeManualPairingCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
  if (!MANUAL_PAIRING_CODE_PATTERN.test(normalized)) {
    throw new Error("API_CLIENT_INVALID_ARGUMENT");
  }
  return normalized;
}

function timestampString(value: unknown): string {
  const timestamp = requiredString(value);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw invalidResponse();
  }
  return timestamp;
}

function parsePairingUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw invalidResponse();
    }
    return parsed;
  } catch {
    throw invalidResponse();
  }
}

function httpStatus(value: unknown): number {
  if (!isHttpStatus(value)) {
    throw invalidResponse();
  }
  return value;
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function apiUrl(path: string): string {
  return path;
}

function invalidResponse(): Error {
  return new Error("API_RESPONSE_INVALID");
}
