const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DESKTOP_ENROLLMENT_POLICY = Object.freeze({
  windowMs: 10 * MINUTE_MS,
  ipAttemptLimit: 240,
  installationAttemptLimit: 10,
  abandonedRetentionMs: 24 * HOUR_MS,
});

export const MANUAL_PAIRING_CLAIM_POLICY = Object.freeze({
  windowMs: 2 * MINUTE_MS,
  ipAttemptLimit: 240,
  installationAttemptLimit: 10,
});

export const PAIRING_TTL_MS = 2 * MINUTE_MS;

export const PAIRING_CREATION_POLICY = Object.freeze({
  windowMs: 10 * MINUTE_MS,
  installationAttemptLimit: 10,
});
