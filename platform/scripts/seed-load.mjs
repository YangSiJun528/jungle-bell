import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_DEVICE_SESSION_TTL_MS,
  DEVICE_SESSION_SCOPES,
  PairingService,
  decodePairingQrPayload,
} from "../apps/api/dist/domain/index.js";
import {
  CryptoRandomSource,
  Sha256Hasher,
  SystemClock,
  randomOpaqueToken,
} from "../apps/api/dist/infra/crypto.js";
import {
  SqliteDesktopIdentityStore,
  SqliteDesktopSessionStore,
  SqlitePairingStore,
  openSqliteDatabase,
} from "../apps/api/dist/infra/sqlite/index.js";
import {
  LOAD_BUNDLE_SCHEMA_VERSION,
  parsePositiveInteger,
  validateLoadBundle,
} from "./load-support.mjs";

process.umask(0o077);

const databasePath = resolve(
  process.env.JB_LOAD_DB_PATH ?? ".data/load.sqlite",
);
const tokenPath = resolve(
  process.env.JB_LOAD_TOKEN_PATH ?? ".data/load-tokens.json",
);
const userCount = parsePositiveInteger(
  process.env.JB_LOAD_USER_COUNT ?? "200",
  "JB_LOAD_USER_COUNT",
  1_000,
);
const nowEpochMs = Date.now();
const desktopSessionTtlMs = 24 * 60 * 60 * 1_000;

await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
const tokenFile = await open(tokenPath, "wx", 0o600);
let completed = false;
let database;

try {
  database = openSqliteDatabase(databasePath);
  assertEmptyLoadDatabase(database);

  const hasher = new Sha256Hasher();
  const identities = new SqliteDesktopIdentityStore(database);
  const desktopSessions = new SqliteDesktopSessionStore(database);
  const pairing = new PairingService({
    clock: new SystemClock(),
    random: new CryptoRandomSource(),
    hasher,
    store: new SqlitePairingStore(database),
    challengeTtlMs: 5 * 60 * 1_000,
    deviceSessionTtlMs: DEFAULT_DEVICE_SESSION_TTL_MS,
  });
  const users = [];

  for (let index = 0; index < userCount; index += 1) {
    const expectedUserId = `load-user-${index}`;
    const desktopDeviceId = `load-desktop-${index}`;
    const identity = await identities.registerVerifiedIdentity({
      candidateUserId: expectedUserId,
      desktopDeviceId,
      subjectHmac: await hasher.hash(`load-lms-subject-${index}`),
      verifiedAtEpochMs: nowEpochMs,
    });
    if (
      identity.userId !== expectedUserId ||
      identity.desktopDeviceId !== desktopDeviceId ||
      !identity.createdUser
    ) {
      throw new Error("LOAD_IDENTITY_SEED_FAILED");
    }

    const desktopToken = randomOpaqueToken("jbas_");
    const desktopInserted = await desktopSessions.insertReplacingActive({
      tokenHash: await hasher.hash(desktopToken),
      userId: identity.userId,
      desktopDeviceId,
      createdAtEpochMs: nowEpochMs,
      expiresAtEpochMs: nowEpochMs + desktopSessionTtlMs,
      revokedAtEpochMs: null,
      version: 0,
    });
    if (!desktopInserted) {
      throw new Error("LOAD_DESKTOP_SESSION_SEED_FAILED");
    }

    const challenge = await pairing.createChallenge({
      userId: identity.userId,
      desktopDeviceId,
    });
    await pairing.claimPairing({
      pairingCode: decodePairingQrPayload(challenge.qrPayload).pairingCode,
      deviceLabel: `Load phone ${index}`,
      installationId: `jbmi_${index
        .toString(16)
        .padStart(32, "0")}`,
    });
    const mobile = await pairing.approvePairing({
      challengeId: challenge.challengeId,
      desktopDeviceId,
      scopes: DEVICE_SESSION_SCOPES,
    });

    users.push({
      userId: identity.userId,
      desktopDeviceId,
      desktopCookie: `jb_app=${desktopToken}`,
      mobileCookie: `jb_device=${mobile.sessionToken}`,
    });
  }

  const bundle = {
    schemaVersion: LOAD_BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date(nowEpochMs).toISOString(),
    users,
  };
  validateLoadBundle(bundle, { expectedUsers: userCount });
  await tokenFile.writeFile(`${JSON.stringify(bundle)}\n`, "utf8");

  assertSeededCounts(database, userCount);
  if (
    database.pragma("integrity_check", { simple: true }) !== "ok" ||
    database.pragma("foreign_key_check").length !== 0
  ) {
    throw new Error("LOAD_SQLITE_INTEGRITY_FAILED");
  }
  completed = true;
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      users: userCount,
      desktopSessions: userCount,
      mobileSessions: userCount,
      databasePath,
      tokenPath,
    })}\n`,
  );
} finally {
  await tokenFile.close();
  database?.close();
  if (!completed) {
    await rm(tokenPath, { force: true });
  }
}

function assertEmptyLoadDatabase(database) {
  for (const table of [
    "users",
    "desktop_devices",
    "desktop_sessions",
    "device_sessions",
  ]) {
    const count = database
      .prepare(`SELECT COUNT(*) FROM ${table}`)
      .pluck()
      .get();
    if (count !== 0) {
      throw new Error("JB_LOAD_DATABASE_MUST_BE_EMPTY");
    }
  }
}

function assertSeededCounts(database, expected) {
  for (const table of [
    "users",
    "external_identities",
    "desktop_devices",
    "desktop_sessions",
    "device_sessions",
  ]) {
    const count = database
      .prepare(`SELECT COUNT(*) FROM ${table}`)
      .pluck()
      .get();
    if (count !== expected) {
      throw new Error(`LOAD_SEED_COUNT_INVALID_${table.toUpperCase()}`);
    }
  }
}
