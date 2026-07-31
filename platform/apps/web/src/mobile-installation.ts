const STORAGE_KEY = "jungle-bell.mobile-installation-id.v1";
const INSTALLATION_ID_PATTERN = /^jbmi_[0-9a-f]{32}$/u;

export function getOrCreateMobileInstallationId(): string {
  const existing = readInstallationId();
  if (existing !== null) {
    return existing;
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("MOBILE_INSTALLATION_ID_UNAVAILABLE");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const installationId =
    "jbmi_" +
    [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  try {
    window.localStorage.setItem(STORAGE_KEY, installationId);
    if (window.localStorage.getItem(STORAGE_KEY) !== installationId) {
      throw new Error("MOBILE_INSTALLATION_STORAGE_UNAVAILABLE");
    }
  } catch {
    throw new Error("MOBILE_INSTALLATION_STORAGE_UNAVAILABLE");
  }
  return installationId;
}

export function getMobileInstallationConfirmationCode(): string | null {
  const installationId = readInstallationId();
  return installationId === null
    ? null
    : installationId.slice(-4).toUpperCase();
}

function readInstallationId(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === null) {
      return null;
    }
    if (!INSTALLATION_ID_PATTERN.test(value)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    throw new Error("MOBILE_INSTALLATION_STORAGE_UNAVAILABLE");
  }
}
