export const LOAD_BUNDLE_SCHEMA_VERSION = 1;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DESKTOP_COOKIE_PATTERN = /^jb_app=jbas_[0-9a-f]{64}$/u;
const MOBILE_COOKIE_PATTERN = /^jb_device=jbs_[0-9a-f]{64}$/u;

export function parsePositiveInteger(value, name, maximum = 10_000) {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > maximum ||
    String(parsed) !== value
  ) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

export function validateLoadBundle(value, { expectedUsers } = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== LOAD_BUNDLE_SCHEMA_VERSION ||
    !isIsoDateTime(value.generatedAt) ||
    !Array.isArray(value.users)
  ) {
    throw new Error("LOAD_BUNDLE_INVALID");
  }
  if (
    expectedUsers !== undefined &&
    value.users.length !== expectedUsers
  ) {
    throw new Error("LOAD_BUNDLE_USER_COUNT_MISMATCH");
  }
  if (value.users.length < 1 || value.users.length > 10_000) {
    throw new Error("LOAD_BUNDLE_USER_COUNT_INVALID");
  }

  const userIds = new Set();
  const desktopDeviceIds = new Set();
  const desktopCookies = new Set();
  const mobileCookies = new Set();
  for (const entry of value.users) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw new Error("LOAD_BUNDLE_ENTRY_INVALID");
    }
    if (!ID_PATTERN.test(entry.userId ?? "")) {
      throw new Error("LOAD_BUNDLE_USER_ID_INVALID");
    }
    if (userIds.has(entry.userId)) {
      throw new Error("LOAD_BUNDLE_DUPLICATE_USER");
    }
    userIds.add(entry.userId);

    if (!ID_PATTERN.test(entry.desktopDeviceId ?? "")) {
      throw new Error("LOAD_BUNDLE_DESKTOP_DEVICE_ID_INVALID");
    }
    if (desktopDeviceIds.has(entry.desktopDeviceId)) {
      throw new Error("LOAD_BUNDLE_DUPLICATE_DESKTOP_DEVICE");
    }
    desktopDeviceIds.add(entry.desktopDeviceId);

    if (!DESKTOP_COOKIE_PATTERN.test(entry.desktopCookie ?? "")) {
      throw new Error("LOAD_BUNDLE_DESKTOP_COOKIE_INVALID");
    }
    if (desktopCookies.has(entry.desktopCookie)) {
      throw new Error("LOAD_BUNDLE_DUPLICATE_DESKTOP_COOKIE");
    }
    desktopCookies.add(entry.desktopCookie);

    if (!MOBILE_COOKIE_PATTERN.test(entry.mobileCookie ?? "")) {
      throw new Error("LOAD_BUNDLE_MOBILE_COOKIE_INVALID");
    }
    if (mobileCookies.has(entry.mobileCookie)) {
      throw new Error("LOAD_BUNDLE_DUPLICATE_MOBILE_COOKIE");
    }
    mobileCookies.add(entry.mobileCookie);
  }
  return value;
}

export function cookieHeader(value, expectedName) {
  const pattern =
    expectedName === "jb_app"
      ? DESKTOP_COOKIE_PATTERN
      : expectedName === "jb_device"
        ? MOBILE_COOKIE_PATTERN
        : null;
  if (pattern === null || !pattern.test(value)) {
    throw new Error("LOAD_COOKIE_INVALID");
  }
  return value;
}

function isIsoDateTime(value) {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}
