import { createHmac } from "node:crypto";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import {
  CampusCollectionWorker,
  CampusCollectorService,
  SqliteCampusRepository,
  SqliteCampusUserRepository,
  campusDataSourceFromEnvironment,
} from "./campus/index.js";
import {
  deriveEncryptionKey,
  readMasterEncryptionKey,
} from "./infra/encryption-key.js";
import {
  SqliteAttendanceSnapshotStore,
  SqliteClaimTransportStore,
  SqliteDesktopIdentityStore,
  SqliteDesktopSessionStore,
  SqlitePairingStore,
  SqlitePushDedupeStore,
  SqlitePushSubscriptionStore,
  SqliteRetentionPruner,
  openSqliteDatabase,
} from "./infra/sqlite/index.js";
import { LmsHttpGateway } from "./lms/gateway.js";
import { AesGcmSessionSealer } from "./lms/session-vault.js";
import {
  NotificationOutboxWorker,
  NotificationService,
  ServerNotificationPlanner,
  SqliteLaundryNotificationLifecycle,
  SqliteNotificationRepository,
  StoreBackedNotificationTargetDirectory,
  WebPushNotificationAdapter,
  type NotificationDeliveryAdapter,
} from "./notifications/index.js";
import {
  PushDeliveryCoordinator,
  WebPushLibrarySender,
  loadVapidConfiguration,
} from "./push/index.js";

process.umask(0o077);

const port = readBoundedEnvironmentInteger("PORT", 8787, 1, 65_535);
const host = process.env.HOST ?? "127.0.0.1";
const nodeEnvironment = process.env.NODE_ENV;
if (nodeEnvironment !== "development" && nodeEnvironment !== "production") {
  throw new Error("NODE_ENV_MUST_BE_DEVELOPMENT_OR_PRODUCTION");
}
const production = nodeEnvironment === "production";
const sessionEncryptionKey = await readSecret(
  "JB_SESSION_ENCRYPTION_KEY",
  "JB_SESSION_ENCRYPTION_KEY_FILE",
);
const identityHmacKey = await readSecret(
  "JB_IDENTITY_HMAC_KEY",
  "JB_IDENTITY_HMAC_KEY_FILE",
);
const vapidPrivateKey = await readSecret(
  "JB_VAPID_PRIVATE_KEY",
  "JB_VAPID_PRIVATE_KEY_FILE",
);
const runtimeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ...(vapidPrivateKey === undefined
    ? {}
    : { JB_VAPID_PRIVATE_KEY: vapidPrivateKey }),
};
const webRoot =
  process.env.JB_WEB_ROOT ??
  fileURLToPath(new URL("../../web/dist", import.meta.url));
const publicOrigin = parsePublicOrigin(
  process.env.JB_PUBLIC_ORIGIN,
  production,
);
const databasePath = resolve(
  process.env.JB_DB_PATH ?? ".data/jungle-bell.sqlite",
);
const minimumFreeDiskBytes = readBoundedEnvironmentInteger(
  "JB_MIN_FREE_DISK_BYTES",
  128 * 1024 * 1024,
  1,
  Number.MAX_SAFE_INTEGER,
);
await mkdir(dirname(databasePath), { recursive: true });
const database = openSqliteDatabase(databasePath);
const pushSubscriptions = new SqlitePushSubscriptionStore(database);
const attendanceSnapshotStore =
  new SqliteAttendanceSnapshotStore(database);
const desktopIdentityStore = new SqliteDesktopIdentityStore(database);
const pairingStore = new SqlitePairingStore(database);
const desktopSessionStore = new SqliteDesktopSessionStore(database);
const vapid = loadVapidConfiguration(runtimeEnvironment);
const pushDeliveryCoordinator = vapid
  ? new PushDeliveryCoordinator({
      subscriptions: pushSubscriptions,
      dedupe: new SqlitePushDedupeStore(
        database,
        7 * 24 * 60 * 60 * 1000,
        2 * 60 * 1000,
      ),
      sender: new WebPushLibrarySender({ vapid }),
      now: Date.now,
      authorizeSubscription: async (subscription, nowEpochMs) =>
        (await pairingStore.listDeviceSessions(
          subscription.userId,
        )).some(
          (session) =>
            session.deviceId === subscription.deviceId &&
            session.revokedAtEpochMs === null &&
            session.expiresAtEpochMs > nowEpochMs &&
            session.scopes.includes("notifications:receive"),
        ),
    })
  : undefined;
const campusRepository = new SqliteCampusRepository(database);
const campusUserRepository =
  new SqliteCampusUserRepository(database);
const notificationRepository =
  new SqliteNotificationRepository(database);
const notificationTargets =
  new StoreBackedNotificationTargetDirectory({
    desktopIdentities: desktopIdentityStore,
    desktopSessions: desktopSessionStore,
    deviceSessions: pairingStore,
    pushSubscriptions,
    webPushEnabled: pushDeliveryCoordinator !== undefined,
  });
const disabledWebPush: NotificationDeliveryAdapter = {
  async deliver() {
    return {
      status: "failed",
      retryable: false,
      errorCode: "WEB_PUSH_NOT_CONFIGURED",
    };
  },
};
const notificationPlanner = new ServerNotificationPlanner(
  campusUserRepository,
);
const laundryLifecycle = new SqliteLaundryNotificationLifecycle({
  database,
  campus: campusRepository,
  rules: campusUserRepository,
  planner: notificationPlanner,
  notifications: notificationRepository,
  now: Date.now,
});
const notificationService = new NotificationService({
  planner: notificationPlanner,
  repository: notificationRepository,
  targets: notificationTargets,
  laundryLifecycle,
  webPush:
    pushDeliveryCoordinator === undefined
      ? disabledWebPush
      : new WebPushNotificationAdapter(pushDeliveryCoordinator),
  now: Date.now,
});
const campusSource =
  production || process.env.JB_CAMPUS_DATA_API_URL !== undefined
    ? campusDataSourceFromEnvironment(runtimeEnvironment)
    : null;
const campusCollector =
  campusSource === null
    ? undefined
    : new CampusCollectorService({
        source: campusSource,
        repository: campusRepository,
        eventSink: notificationService,
        now: Date.now,
      });
const masterKey = readMasterEncryptionKey(
  sessionEncryptionKey,
  production,
);
const identityKey =
  identityHmacKey === undefined && !production
    ? masterKey
    : readMasterEncryptionKey(
        identityHmacKey,
        production,
        "JB_IDENTITY_HMAC_KEY",
      );
const lmsGateway = new LmsHttpGateway();
const app = await buildApp({
  logger: production,
  allowDevBootstrap:
    !production && process.env.JB_ALLOW_DEV_BOOTSTRAP === "true",
  ...(process.env.JB_TRUST_PROXY_HOPS
    ? {
        trustProxy: parseBoundedInteger(
          process.env.JB_TRUST_PROXY_HOPS,
          "JB_TRUST_PROXY_HOPS",
          1,
          255,
        ),
      }
    : {}),
  attendanceSnapshotStore,
  ...(campusCollector === undefined ? {} : { campusCollector }),
  campusUserRepository,
  desktopIdentityStore,
  pairingStore,
  pairingApprovalTransportStore: pairingStore,
  notificationEventSink: notificationService,
  notificationRepository,
  desktopSessionStore,
  claimTransportStore: new SqliteClaimTransportStore(database),
  pushSubscriptionStore: pushSubscriptions,
  readinessCheck: async () => {
    const probe = database
      .prepare("SELECT 1 AS ready")
      .get() as { ready?: unknown } | undefined;
    if (probe?.ready !== 1) {
      return false;
    }
    const filesystem = await statfs(dirname(databasePath));
    return (
      filesystem.bavail * filesystem.bsize >=
      minimumFreeDiskBytes
    );
  },
  ...(vapid && pushDeliveryCoordinator
    ? {
        vapidPublicKey: vapid.publicKey,
        pushDeliveryCoordinator,
      }
    : {}),
  tokenSealer: new AesGcmSessionSealer(
    deriveEncryptionKey(masterKey, "pairing-transport-v1"),
  ),
  lmsGateway,
  lmsSubjectToIdentityHash: (subject) =>
    createHmac(
      "sha256",
      deriveEncryptionKey(identityKey, "lms-identity-v1"),
    )
      .update("jungle-lms\0user-id\0", "utf8")
      .update(subject, "utf8")
      .digest("hex"),
  ...(publicOrigin ? { publicOrigin } : {}),
  webRoot,
});
const notificationWorker = new NotificationOutboxWorker({
  runner: notificationService,
  maintenance: new SqliteRetentionPruner(database),
  logger: { warn: (message) => app.log.warn(message) },
});
const campusWorker =
  campusCollector === undefined
    ? null
    : new CampusCollectionWorker({
        runner: campusCollector,
        logger: { warn: (message) => app.log.warn(message) },
      });
app.addHook("onClose", async () => {
  try {
    await campusWorker?.stop();
    await notificationWorker.stop();
  } finally {
    database.close();
  }
});

let shutdownPromise: Promise<void> | null = null;
const removeShutdownHandlers = () => {
  process.removeListener("SIGINT", handleShutdownSignal);
  process.removeListener("SIGTERM", handleShutdownSignal);
};
const shutdown = (): Promise<void> => {
  if (shutdownPromise !== null) {
    return shutdownPromise;
  }
  removeShutdownHandlers();
  shutdownPromise = (async () => {
    try {
      await app.close();
    } catch (error) {
      process.exitCode = 1;
      app.log.error({ err: error }, "API shutdown failed");
    }
  })();
  return shutdownPromise;
};
function handleShutdownSignal() {
  void shutdown();
}

try {
  await app.listen({ host, port });
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  await notificationWorker.start();
  if (shutdownPromise === null) {
    await campusWorker?.start();
  }
} catch (error) {
  removeShutdownHandlers();
  await shutdown();
  throw error;
}

async function readSecret(
  valueName: string,
  fileName: string,
): Promise<string | undefined> {
  const direct = process.env[valueName];
  const path = process.env[fileName];
  if (direct && path) {
    throw new Error(`${valueName}_AND_FILE_ARE_MUTUALLY_EXCLUSIVE`);
  }
  if (direct) {
    return direct;
  }
  if (!path) {
    return undefined;
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) {
    throw new Error(`${fileName}_IS_EMPTY`);
  }
  return value;
}

function parseBoundedInteger(
  value: string,
  name: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    String(parsed) !== value
  ) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

function readBoundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = process.env[name];
  return value === undefined
    ? fallback
    : parseBoundedInteger(value, name, minimum, maximum);
}

function parsePublicOrigin(
  value: string | undefined,
  production: boolean,
): string | undefined {
  if (value === undefined || value === "") {
    if (production) {
      throw new Error("JB_PUBLIC_ORIGIN_REQUIRED");
    }
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("JB_PUBLIC_ORIGIN_INVALID");
  }
  if (
    url.origin !== value.replace(/\/$/u, "") ||
    url.username !== "" ||
    url.password !== "" ||
    (production && url.protocol !== "https:")
  ) {
    throw new Error("JB_PUBLIC_ORIGIN_INVALID");
  }
  return url.origin;
}
