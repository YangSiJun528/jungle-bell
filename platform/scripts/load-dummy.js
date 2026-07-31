import { check, fail } from "k6";
import http from "k6/http";
import execution from "k6/execution";
import { SharedArray } from "k6/data";

const baseUrl = (__ENV.JB_LOAD_ORIGIN || "http://127.0.0.1:8787").replace(
  /\/$/u,
  "",
);
const publicOrigin = (
  __ENV.JB_LOAD_PUBLIC_ORIGIN || baseUrl
).replace(/\/$/u, "");
const expectedUsers = boundedInteger(
  __ENV.JB_LOAD_USER_COUNT || "200",
  1,
  1_000,
  "JB_LOAD_USER_COUNT",
);
const desktopIterations = boundedInteger(
  __ENV.JB_LOAD_DESKTOP_ITERATIONS || "2",
  1,
  100,
  "JB_LOAD_DESKTOP_ITERATIONS",
);
const mobileIterations = boundedInteger(
  __ENV.JB_LOAD_MOBILE_ITERATIONS || "3",
  1,
  100,
  "JB_LOAD_MOBILE_ITERATIONS",
);
const tokenFile = __ENV.JB_LOAD_TOKENS_FILE;
if (!tokenFile) {
  throw new Error("JB_LOAD_TOKENS_FILE is required");
}

const users = new SharedArray("load identities", () => {
  const parsed = JSON.parse(open(tokenFile));
  if (
    parsed?.schemaVersion !== 1 ||
    !Array.isArray(parsed.users) ||
    parsed.users.length !== expectedUsers
  ) {
    throw new Error("load token bundle is invalid");
  }
  const seenUsers = new Set();
  const seenDesktopDevices = new Set();
  return parsed.users.map((entry) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry?.userId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(
        entry?.desktopDeviceId,
      ) ||
      !/^jb_app=jbas_[0-9a-f]{64}$/u.test(entry?.desktopCookie) ||
      !/^jb_device=jbs_[0-9a-f]{64}$/u.test(entry?.mobileCookie) ||
      seenUsers.has(entry.userId) ||
      seenDesktopDevices.has(entry.desktopDeviceId)
    ) {
      throw new Error("load token bundle contains an invalid entry");
    }
    seenUsers.add(entry.userId);
    seenDesktopDevices.add(entry.desktopDeviceId);
    return entry;
  });
});

export const options = {
  scenarios: {
    desktop_sync_burst: {
      executor: "per-vu-iterations",
      exec: "desktopSync",
      vus: expectedUsers,
      iterations: desktopIterations,
      maxDuration: __ENV.JB_LOAD_MAX_DURATION || "2m",
      gracefulStop: "10s",
    },
    mobile_read_burst: {
      executor: "per-vu-iterations",
      exec: "mobileRead",
      startTime: "2s",
      vus: expectedUsers,
      iterations: mobileIterations,
      maxDuration: __ENV.JB_LOAD_MAX_DURATION || "2m",
      gracefulStop: "10s",
    },
    public_read_steady: {
      executor: "constant-arrival-rate",
      exec: "publicRead",
      startTime: "4s",
      rate: boundedInteger(
        __ENV.JB_LOAD_PUBLIC_RATE || "20",
        1,
        1_000,
        "JB_LOAD_PUBLIC_RATE",
      ),
      timeUnit: "1s",
      duration: __ENV.JB_LOAD_PUBLIC_DURATION || "20s",
      preAllocatedVUs: 20,
      maxVUs: 100,
      gracefulStop: "5s",
    },
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{surface:desktop}": ["p(95)<1500", "p(99)<3000"],
    "http_req_duration{surface:mobile}": ["p(95)<1500", "p(99)<3000"],
    "http_req_duration{surface:public}": ["p(95)<1000", "p(99)<2500"],
  },
};

export function setup() {
  const health = http.get(`${baseUrl}/api/health`, {
    tags: { operation: "health", surface: "public" },
  });
  assertResponse(health, [200], "health");
  const first = users[0];
  const pairedMobileCookie = exercisePairing(first.desktopCookie);
  exercisePushSubscription(pairedMobileCookie);
  return { setupCompleted: true };
}

export function desktopSync() {
  const user = currentUser();
  const headers = jsonHeaders(user.desktopCookie);
  const heartbeat = http.post(
    `${baseUrl}/api/private/desktop/heartbeat`,
    JSON.stringify({
      lmsSessionState: "connected",
      appVersion: "k6-load",
    }),
    {
      headers,
      tags: { operation: "desktop-heartbeat", surface: "desktop" },
    },
  );
  check(heartbeat, {
    "desktop heartbeat is 200": (response) => response.status === 200,
    "desktop heartbeat has receipt time": (response) =>
      typeof response.json("receivedAt") === "string",
  });

  const now = new Date();
  const snapshot = http.post(
    `${baseUrl}/api/private/desktop/attendance-snapshot`,
    JSON.stringify({
      attendanceDate: kstDate(now),
      cohortId: "load-cohort",
      cohortStatus: "active",
      cohortStartDate: "2026-01-01",
      cohortEndDate: "2027-12-31",
      morningChecked: execution.scenario.iterationInTest % 2 === 0,
      eveningChecked: execution.scenario.iterationInTest % 3 === 0,
      collectedAt: now.toISOString(),
    }),
    {
      headers,
      tags: {
        operation: "desktop-attendance-upload",
        surface: "desktop",
      },
    },
  );
  check(snapshot, {
    "attendance upload is 200": (response) => response.status === 200,
    "attendance upload returns state": (response) =>
      response.json("attendance.status") === "available",
  });

  const dashboard = http.get(
    `${baseUrl}/api/private/desktop/dashboard`,
    {
      headers: cookieHeaders(user.desktopCookie),
      tags: { operation: "desktop-dashboard", surface: "desktop" },
    },
  );
  check(dashboard, {
    "desktop dashboard is 200": (response) => response.status === 200,
    "desktop dashboard has device": (response) =>
      response.json("desktop.id") === user.desktopDeviceId,
  });
}

export function mobileRead() {
  const user = currentUser();
  const dashboard = http.get(`${baseUrl}/api/private/dashboard`, {
    headers: cookieHeaders(user.mobileCookie),
    tags: { operation: "mobile-dashboard", surface: "mobile" },
  });
  check(dashboard, {
    "mobile dashboard is 200": (response) => response.status === 200,
    "mobile dashboard has attendance": (response) =>
      response.json("attendance.status") === "available",
  });
}

export function publicRead() {
  const responses = http.batch([
    [
      "GET",
      `${baseUrl}/api/public/campus/laundry`,
      null,
      { tags: { operation: "public-laundry", surface: "public" } },
    ],
    [
      "GET",
      `${baseUrl}/api/public/campus/meals`,
      null,
      { tags: { operation: "public-meals", surface: "public" } },
    ],
    [
      "GET",
      `${baseUrl}/api/public/campus/meals/history?limit=5`,
      null,
      { tags: { operation: "public-meal-history", surface: "public" } },
    ],
  ]);
  check(responses[0], {
    "public laundry is 200": (response) => response.status === 200,
    "public laundry contract": (response) =>
      response.json("kind") === "laundry" &&
      response.json("data") !== null,
  });
  check(responses[1], {
    "public meals is 200": (response) => response.status === 200,
    "public meals contract": (response) =>
      response.json("kind") === "meals" && response.json("data") !== null,
  });
  check(responses[2], {
    "public meal history is 200": (response) => response.status === 200,
    "public meal history contract": (response) =>
      Array.isArray(response.json("posts")),
  });
}

function exercisePairing(desktopCookie) {
  const desktopHeaders = cookieHeaders(desktopCookie, true);
  const pairing = http.post(`${baseUrl}/api/pairings`, null, {
    headers: desktopHeaders,
    tags: { operation: "pairing-create", surface: "desktop" },
  });
  assertResponse(pairing, [201], "pairing creation");
  const pairingId = pairing.json("pairingId");
  const challenge = readFragmentValue(pairing.json("qrPayload"), "challenge");

  const claim = http.post(
    `${baseUrl}/api/pairings/${encodeURIComponent(pairingId)}/claims`,
    JSON.stringify({
      challenge,
      deviceLabel: "k6 paired phone",
      installationId: `jbmi_${"a".repeat(32)}`,
    }),
    {
      headers: jsonHeaders(),
      tags: { operation: "pairing-claim", surface: "mobile" },
    },
  );
  assertResponse(claim, [201], "pairing claim");
  const claimId = claim.json("claimId");
  const claimReceipt = claim.json("claimReceipt");

  const approval = http.post(
    `${baseUrl}/api/pairings/${encodeURIComponent(pairingId)}/approve`,
    JSON.stringify({ claimId }),
    {
      headers: jsonHeaders(desktopCookie),
      tags: { operation: "pairing-approve", surface: "desktop" },
    },
  );
  assertResponse(approval, [204], "pairing approval");

  const completion = http.post(
    `${baseUrl}/api/pairings/${encodeURIComponent(pairingId)}/complete`,
    JSON.stringify({ claimId, claimReceipt }),
    {
      headers: jsonHeaders(),
      tags: { operation: "pairing-complete", surface: "mobile" },
    },
  );
  assertResponse(completion, [204], "pairing completion");
  const mobileToken = completion.cookies.jb_device?.[0]?.value;
  if (!/^jbs_[0-9a-f]{64}$/u.test(mobileToken || "")) {
    fail("pairing completion did not issue jb_device");
  }
  return `jb_device=${mobileToken}`;
}

function exercisePushSubscription(mobileCookie) {
  const suffix = String(Date.now());
  const stored = http.put(
    `${baseUrl}/api/push/subscriptions`,
    JSON.stringify({
      endpoint: `https://updates.push.services.mozilla.com/wpush/jungle-bell-load-${suffix}`,
      expirationTime: null,
      keys: {
        auth: "a".repeat(22),
        p256dh: "b".repeat(87),
      },
    }),
    {
      headers: jsonHeaders(mobileCookie),
      tags: { operation: "push-subscribe", surface: "mobile" },
    },
  );
  assertResponse(stored, [200, 201], "push subscription");
  const subscriptionId = stored.json("subscriptionId");
  if (!/^jbps_[0-9a-f]{64}$/u.test(subscriptionId || "")) {
    fail("push subscription response is invalid");
  }

  const removed = http.del(
    `${baseUrl}/api/push/subscriptions/${encodeURIComponent(
      subscriptionId,
    )}`,
    null,
    {
      headers: cookieHeaders(mobileCookie, true),
      tags: { operation: "push-unsubscribe", surface: "mobile" },
    },
  );
  assertResponse(removed, [204], "push unsubscription");
}

function currentUser() {
  return users[(execution.vu.idInTest - 1) % users.length];
}

function jsonHeaders(cookie) {
  return {
    "content-type": "application/json",
    origin: publicOrigin,
    ...(cookie ? cookieHeaders(cookie) : {}),
  };
}

function cookieHeaders(cookie, includeOrigin = false) {
  return {
    cookie,
    ...(includeOrigin ? { origin: publicOrigin } : {}),
  };
}

function assertResponse(response, allowedStatuses, operation) {
  if (!allowedStatuses.includes(response.status)) {
    fail(`${operation} failed with HTTP ${response.status}: ${response.body}`);
  }
}

function readFragmentValue(value, key) {
  if (typeof value !== "string") {
    fail("pairing QR payload is missing");
  }
  const fragment = value.split("#", 2)[1] || "";
  for (const pair of fragment.split("&")) {
    const [name, encoded] = pair.split("=", 2);
    if (name === key && encoded) {
      return decodeURIComponent(encoded.replace(/\+/gu, " "));
    }
  }
  fail(`pairing QR fragment is missing ${key}`);
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    String(parsed) !== value
  ) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function kstDate(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}
