import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { validateLoadBundle } from "./load-support.mjs";

const execute = promisify(execFile);
const USER_COUNT = 200;
const CAMPUS_PRODUCTION_ORIGIN =
  "https://jungle-bell-api.yangsijun5528.workers.dev";
const useLiveCampus =
  process.argv.includes("--live-campus") ||
  process.env.JB_SMOKE_LIVE_CAMPUS === "true";
const runK6 = process.argv.includes("--k6");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "jungle-bell-platform-smoke-"),
);
const databasePath = join(temporaryDirectory, "smoke.sqlite");
const tokenPath = join(temporaryDirectory, "load-tokens.json");
let fakeCampus;
let apiProcess;
let apiLogs = "";
const durations = [];
let succeeded = false;

try {
  const campusOrigin = useLiveCampus
    ? CAMPUS_PRODUCTION_ORIGIN
    : await startFakeCampus();
  fakeCampus = useLiveCampus ? undefined : campusOrigin.server;
  const campusDataOrigin = useLiveCampus
    ? campusOrigin
    : campusOrigin.origin;

  await execute(process.execPath, ["scripts/seed-load.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JB_LOAD_DB_PATH: databasePath,
      JB_LOAD_TOKEN_PATH: tokenPath,
      JB_LOAD_USER_COUNT: String(USER_COUNT),
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const bundle = validateLoadBundle(
    JSON.parse(await readFile(tokenPath, "utf8")),
    { expectedUsers: USER_COUNT },
  );

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  apiProcess = spawn(process.execPath, ["apps/api/dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "development",
      JB_ALLOW_DEV_BOOTSTRAP: "false",
      JB_DB_PATH: databasePath,
      JB_PUBLIC_ORIGIN: origin,
      JB_CAMPUS_DATA_API_URL: campusDataOrigin,
      JB_SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout.on("data", appendApiLog);
  apiProcess.stderr.on("data", appendApiLog);

  await waitForHealth(origin);
  const campus = await waitForCampusData(origin);
  assertPublicCampus(campus);

  await runPool(bundle.users, 32, async (user, index) => {
    const desktopHeaders = mutationHeaders(
      origin,
      user.desktopCookie,
    );
    const heartbeat = await timedJson(
      `${origin}/api/private/desktop/heartbeat`,
      {
        method: "POST",
        headers: desktopHeaders,
        body: JSON.stringify({
          lmsSessionState: "connected",
          appVersion: "platform-smoke",
        }),
      },
      200,
      "desktop heartbeat",
    );
    if (!isIsoDateTime(heartbeat.receivedAt)) {
      throw new Error("SMOKE_HEARTBEAT_RESPONSE_INVALID");
    }

    const collectedAt = new Date(Date.now() - index).toISOString();
    const attendance = await timedJson(
      `${origin}/api/private/desktop/attendance-snapshot`,
      {
        method: "POST",
        headers: desktopHeaders,
        body: JSON.stringify({
          attendanceDate: kstDate(new Date(collectedAt)),
          cohortId: "load-cohort",
          cohortStatus: "active",
          cohortStartDate: "2026-01-01",
          cohortEndDate: "2027-12-31",
          morningChecked: index % 2 === 0,
          eveningChecked: index % 3 === 0,
          collectedAt,
        }),
      },
      200,
      "attendance upload",
    );
    if (
      attendance.attendance?.status !== "available" ||
      attendance.attendance?.snapshot?.sourceDeviceId !==
        user.desktopDeviceId
    ) {
      throw new Error("SMOKE_ATTENDANCE_RESPONSE_INVALID");
    }

    const [desktopDashboard, mobileDashboard] = await Promise.all([
      timedJson(
        `${origin}/api/private/desktop/dashboard`,
        { headers: { cookie: user.desktopCookie } },
        200,
        "desktop dashboard",
      ),
      timedJson(
        `${origin}/api/private/dashboard`,
        { headers: { cookie: user.mobileCookie } },
        200,
        "mobile dashboard",
      ),
    ]);
    if (
      desktopDashboard.desktop?.id !== user.desktopDeviceId ||
      desktopDashboard.attendance?.snapshot?.sourceDeviceId !==
        user.desktopDeviceId ||
      mobileDashboard.attendance?.snapshot?.sourceDeviceId !==
        user.desktopDeviceId
    ) {
      throw new Error("SMOKE_DASHBOARD_ISOLATION_FAILED");
    }
  });

  await exercisePairingAndPush(origin, bundle.users[0].desktopCookie);

  const healthAfterLoad = await timedJson(
    `${origin}/api/health`,
    {},
    200,
    "health after load",
  );
  if (healthAfterLoad.status !== "ok") {
    throw new Error("SMOKE_HEALTH_BODY_INVALID");
  }
  const readinessAfterLoad = await timedJson(
    `${origin}/api/ready`,
    {},
    200,
    "readiness after load",
  );
  if (readinessAfterLoad.status !== "ready") {
    throw new Error("SMOKE_READINESS_BODY_INVALID");
  }
  if (runK6) {
    const k6 = await execute(
      "k6",
      [
        "run",
        "-e",
        `JB_LOAD_ORIGIN=${origin}`,
        "-e",
        `JB_LOAD_PUBLIC_ORIGIN=${origin}`,
        "-e",
        `JB_LOAD_TOKENS_FILE=${tokenPath}`,
        "-e",
        `JB_LOAD_USER_COUNT=${USER_COUNT}`,
        "scripts/load-dummy.js",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    process.stdout.write(k6.stdout);
    if (k6.stderr) {
      process.stderr.write(k6.stderr);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      users: USER_COUNT,
      checks: [
        "desktop-heartbeat",
        "desktop-attendance-upload",
        "desktop-dashboard",
        "mobile-dashboard",
        "public-campus-laundry",
        "public-campus-meals",
        "public-meal-history",
        "http-pairing",
        "push-subscribe-unsubscribe",
      ],
      campus: useLiveCampus ? "live" : "deterministic-fake",
      k6: runK6 ? "passed" : "not-requested",
      requests: durations.length,
      latencyMs: summarizeDurations(durations),
    })}\n`,
  );
  succeeded = true;
} catch (error) {
  if (apiLogs.trim()) {
    process.stderr.write(`API output:\n${apiLogs.trim()}\n`);
  }
  throw error;
} finally {
  await stopChild(apiProcess);
  await closeServer(fakeCampus);
  if (
    !succeeded &&
    process.env.JB_SMOKE_KEEP_TEMP_ON_FAILURE === "true"
  ) {
    process.stderr.write(
      `Smoke artifacts retained at ${temporaryDirectory}\n`,
    );
  } else {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function exercisePairingAndPush(origin, desktopCookie) {
  const pairing = await timedJson(
    `${origin}/api/pairings`,
    {
      method: "POST",
      headers: mutationHeaders(origin, desktopCookie, false),
    },
    201,
    "pairing creation",
  );
  const pairingId = requireString(pairing.pairingId, "pairing ID");
  const challenge = readFragmentValue(pairing.qrPayload, "challenge");
  const claim = await timedJson(
    `${origin}/api/pairings/${encodeURIComponent(pairingId)}/claims`,
    {
      method: "POST",
      headers: mutationHeaders(origin),
      body: JSON.stringify({
        challenge,
        deviceLabel: "Smoke phone",
        installationId: `jbmi_${"b".repeat(32)}`,
      }),
    },
    201,
    "pairing claim",
  );
  const claimId = requireString(claim.claimId, "claim ID");
  const claimReceipt = requireString(claim.claimReceipt, "claim receipt");
  await timedJson(
    `${origin}/api/pairings/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      headers: mutationHeaders(origin, desktopCookie),
      body: JSON.stringify({ claimId }),
    },
    204,
    "pairing approval",
  );
  const completion = await timedFetch(
    `${origin}/api/pairings/${encodeURIComponent(pairingId)}/complete`,
    {
      method: "POST",
      headers: mutationHeaders(origin),
      body: JSON.stringify({ claimId, claimReceipt }),
    },
    204,
    "pairing completion",
  );
  const mobileToken = completion.headers
    .get("set-cookie")
    ?.match(/(?:^|,\s*)jb_device=(jbs_[0-9a-f]{64});/u)?.[1];
  if (!mobileToken) {
    throw new Error("SMOKE_PAIRING_COOKIE_MISSING");
  }
  const mobileCookie = `jb_device=${mobileToken}`;

  const subscription = await timedJson(
    `${origin}/api/push/subscriptions`,
    {
      method: "PUT",
      headers: mutationHeaders(origin, mobileCookie),
      body: JSON.stringify({
        endpoint:
          "https://updates.push.services.mozilla.com/wpush/jungle-bell-platform-smoke",
        expirationTime: null,
        keys: {
          auth: "a".repeat(22),
          p256dh: "b".repeat(87),
        },
      }),
    },
    [200, 201],
    "push subscription",
  );
  const subscriptionId = requireString(
    subscription.subscriptionId,
    "push subscription ID",
  );
  if (!/^jbps_[0-9a-f]{64}$/u.test(subscriptionId)) {
    throw new Error("SMOKE_PUSH_SUBSCRIPTION_ID_INVALID");
  }
  await timedJson(
    `${origin}/api/push/subscriptions/${encodeURIComponent(
      subscriptionId,
    )}`,
    {
      method: "DELETE",
      headers: mutationHeaders(origin, mobileCookie, false),
    },
    204,
    "push unsubscription",
  );
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null) {
      throw new Error("SMOKE_API_EXITED_BEFORE_HEALTH");
    }
    try {
      const response = await fetch(`${origin}/api/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await delay(100);
  }
  throw new Error("SMOKE_API_READINESS_TIMEOUT");
}

async function waitForCampusData(origin) {
  const deadline = Date.now() + (useLiveCampus ? 30_000 : 15_000);
  let lastStatus = "unavailable";
  while (Date.now() < deadline) {
    try {
      const [laundry, meals, history] = await Promise.all([
        fetchJson(`${origin}/api/public/campus/laundry`, {}, 200),
        fetchJson(`${origin}/api/public/campus/meals`, {}, 200),
        fetchJson(
          `${origin}/api/public/campus/meals/history?limit=5`,
          {},
          200,
        ),
      ]);
      if (
        laundry.data !== null &&
        meals.data !== null &&
        Array.isArray(history.posts)
      ) {
        return { laundry, meals, history };
      }
      lastStatus = JSON.stringify({
        laundry: laundry.data === null ? "empty" : "ready",
        meals: meals.data === null ? "empty" : "ready",
      });
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "unknown";
    }
    await delay(200);
  }
  throw new Error(`SMOKE_CAMPUS_TIMEOUT: ${lastStatus}`);
}

function assertPublicCampus({ laundry, meals, history }) {
  if (
    laundry.kind !== "laundry" ||
    !Array.isArray(laundry.data?.machines) ||
    meals.kind !== "meals" ||
    !Array.isArray(meals.data?.data?.dailyMenus) ||
    !Array.isArray(history.posts)
  ) {
    throw new Error("SMOKE_PUBLIC_CAMPUS_CONTRACT_INVALID");
  }
}

async function timedJson(
  url,
  options,
  expectedStatus,
  operation,
) {
  const response = await timedFetch(
    url,
    options,
    expectedStatus,
    operation,
  );
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

async function timedFetch(
  url,
  options,
  expectedStatus,
  operation,
) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  durations.push(performance.now() - startedAt);
  const allowed = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  if (!allowed.includes(response.status)) {
    const safeBody = (await response.text()).slice(0, 512);
    throw new Error(
      `${operation} returned HTTP ${response.status}: ${safeBody}`,
    );
  }
  return response;
}

async function fetchJson(url, options, expectedStatus) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`HTTP_${response.status}`);
  }
  return response.json();
}

function mutationHeaders(origin, cookie, json = true) {
  return {
    origin,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(cookie ? { cookie } : {}),
  };
}

async function runPool(values, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) {
          return;
        }
        await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
}

async function startFakeCampus() {
  const laundry = fakeLaundry();
  const meals = fakeMeals();
  const history = {
    posts: meals.data.dailyMenus,
    nextBefore: null,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const payload =
      url.pathname === "/v1/laundry/latest"
        ? laundry
        : url.pathname === "/v1/meals"
          ? meals
          : url.pathname === "/v1/meals/history"
            ? history
            : null;
    if (payload === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      etag: `"smoke-${url.pathname}"`,
    });
    response.end(JSON.stringify(payload));
  });
  const origin = await listenOnEphemeralPort(server);
  return { origin, server };
}

function fakeLaundry() {
  const observedAt = "2026-07-31T00:00:00.000Z";
  return {
    schemaVersion: 1,
    sourceVersionSha: "smoke-laundry-sha",
    asOf: observedAt,
    final: false,
    quality: {
      collection: "SUCCESS",
      sourceFreshness: "REFRESH_OBSERVED",
      certainty: "OBSERVED_API_VALUE",
      basis: "HASH_CADENCE",
      lastCheckedAt: observedAt,
      expectedRefreshIntervalSeconds: 60,
    },
    machines: [
      {
        id: "tower-1",
        washer: fakeAppliance("tower-1", "washer", observedAt),
        dryer: null,
      },
    ],
    events: [],
    unknownEnums: [],
  };
}

function fakeAppliance(machineId, appliance, observedAt) {
  return {
    machineId,
    appliance,
    observedAt,
    state: { code: "IDLE", raw: "IDLE", known: true },
    operationalStatus: "IDLE",
    remainingMinutes: 0,
    totalMinutes: 0,
    startedAt: observedAt,
    estimatedFinishAt: null,
    remoteControlEnabled: false,
    cycleCount: 0,
    sessionId: null,
    errorCode: null,
    projection: {
      asOf: observedAt,
      remainingMinutes: 0,
      status: "IDLE",
      estimated: false,
    },
  };
}

function fakeMeals() {
  const observedAt = "2026-07-31T00:00:00.000Z";
  const post = {
    id: "smoke-meal",
    kind: "DAILY_MENU",
    contentSha: "smoke-meal-sha",
    title: "Smoke meal",
    text: "Breakfast / Lunch / Dinner",
    pinned: false,
    publishedAt: observedAt,
    updatedAt: observedAt,
    permalink: "https://example.com/smoke-meal",
    status: "published",
    images: [],
  };
  return {
    asOf: observedAt,
    lastCheckedAt: observedAt,
    data: {
      schemaVersion: 2,
      sourceVersionSha: "smoke-meals-sha",
      observedAt,
      hasNext: false,
      pinnedMenus: [],
      dailyMenus: [post],
      otherPosts: [],
      currentWeeklyMenu: {
        targetWeekKey: "2026-07-27",
        status: "AVAILABLE",
        contentSha: post.contentSha,
        post,
      },
      recentMenus: [post],
      weeklyMenus: [
        {
          weekKey: "2026-07-27",
          contentSha: post.contentSha,
          post,
        },
      ],
      historyNextBefore: null,
    },
  };
}

async function reservePort() {
  const server = createServer();
  const origin = await listenOnEphemeralPort(server);
  const port = Number.parseInt(new URL(origin).port, 10);
  await closeServer(server);
  return port;
}

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("SMOKE_EPHEMERAL_PORT_UNAVAILABLE"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  const exitPromise = new Promise((resolve) => {
    child.once("exit", () => resolve(true));
    if (child.exitCode !== null) {
      resolve(true);
    }
  });
  child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function appendApiLog(chunk) {
  apiLogs = `${apiLogs}${String(chunk)}`.slice(-32 * 1024);
}

function readFragmentValue(value, key) {
  if (typeof value !== "string") {
    throw new Error("SMOKE_PAIRING_QR_INVALID");
  }
  const fragment = value.split("#", 2)[1] ?? "";
  for (const pair of fragment.split("&")) {
    const [name, encoded] = pair.split("=", 2);
    if (name === key && encoded) {
      return decodeURIComponent(encoded.replaceAll("+", " "));
    }
  }
  throw new Error(`SMOKE_PAIRING_QR_MISSING_${key.toUpperCase()}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`SMOKE_${label.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  }
  return value;
}

function isIsoDateTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function kstDate(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return round(sorted[Math.ceil(sorted.length * ratio) - 1]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
