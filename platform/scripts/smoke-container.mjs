import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import webPush from "web-push";

const execute = promisify(execFile);
const image = process.env.JB_SMOKE_IMAGE ?? "jungle-bell-platform:smoke";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const volume = `jungle-bell-platform-smoke-${suffix}`;
const productionContainer = `jungle-bell-platform-smoke-prod-${suffix}`;
const firstContainer = `jungle-bell-platform-smoke-a-${suffix}`;
const secondContainer = `jungle-bell-platform-smoke-b-${suffix}`;
const directory = await mkdtemp(
  join(tmpdir(), "jungle-bell-container-smoke-"),
);
const keyPath = join(directory, "session-encryption-key");
const key = randomBytes(32).toString("base64");
const identityKeyPath = join(directory, "identity-hmac-key");
const identityKey = randomBytes(32).toString("base64");
const vapidPrivateKeyPath = join(directory, "vapid-private-key");
const vapid = webPush.generateVAPIDKeys();

await writeFile(keyPath, `${key}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await writeFile(identityKeyPath, `${identityKey}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await writeFile(vapidPrivateKeyPath, `${vapid.privateKey}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

let productionStarted = false;
let firstStarted = false;
let secondStarted = false;
let volumeCreated = false;

try {
  await docker(["volume", "create", volume]);
  volumeCreated = true;

  const productionOrigin = await startContainer(
    productionContainer,
    "production",
  );
  productionStarted = true;
  await waitForHealth(productionOrigin);
  await assertDevelopmentBootstrapDisabled(productionOrigin);
  await docker(["stop", "--time", "10", productionContainer]);
  productionStarted = false;
  await docker(["rm", productionContainer]);

  const firstOrigin = await startContainer(firstContainer, "development");
  firstStarted = true;
  await waitForHealth(firstOrigin);
  const appSessionCookie = await createDevelopmentAppSession(firstOrigin);
  await assertAppSession(firstOrigin, appSessionCookie);
  await writeDesktopState(firstOrigin, appSessionCookie);

  await docker(["stop", "--time", "10", firstContainer]);
  firstStarted = false;
  await docker(["rm", firstContainer]);

  const secondOrigin = await startContainer(secondContainer, "development");
  secondStarted = true;
  await waitForHealth(secondOrigin);
  await assertAppSession(secondOrigin, appSessionCookie);
  await assertDesktopStatePersisted(secondOrigin, appSessionCookie);

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      checks: [
        "production-secret-files",
        "production-vapid-config",
        "production-dev-route-disabled",
        "container-readiness",
        "sqlite-write",
        "graceful-stop",
        "sqlite-restart-persistence",
        "desktop-heartbeat-persistence",
        "attendance-snapshot-persistence",
      ],
    })}\n`,
  );
} finally {
  if (productionStarted) {
    await cleanupContainer(productionContainer);
  }
  if (firstStarted) {
    await cleanupContainer(firstContainer);
  }
  if (secondStarted) {
    await cleanupContainer(secondContainer);
  }
  if (volumeCreated) {
    await docker(["volume", "rm", volume], true);
  }
  await rm(directory, { force: true, recursive: true });
}

async function startContainer(name, environment) {
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::8787",
    "--volume",
    `${volume}:/app/data`,
    "--mount",
    `type=bind,src=${keyPath},dst=/run/secrets/session_encryption_key,readonly`,
    "--read-only",
    "--tmpfs",
    "/tmp:size=128m,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--env",
    `NODE_ENV=${environment}`,
    "--env",
    `JB_PUBLIC_ORIGIN=${
      environment === "production"
        ? "https://smoke.example"
        : "http://127.0.0.1"
    }`,
    "--env",
    "JB_SESSION_ENCRYPTION_KEY_FILE=/run/secrets/session_encryption_key",
    "--env",
    "JB_CAMPUS_DATA_API_URL=https://jungle-bell-api.yangsijun5528.workers.dev",
  ];
  if (environment === "production") {
    args.push(
      "--mount",
      `type=bind,src=${identityKeyPath},dst=/run/secrets/identity_hmac_key,readonly`,
      "--env",
      "JB_IDENTITY_HMAC_KEY_FILE=/run/secrets/identity_hmac_key",
      "--mount",
      `type=bind,src=${vapidPrivateKeyPath},dst=/run/secrets/vapid_private_key,readonly`,
      "--env",
      "JB_VAPID_PRIVATE_KEY_FILE=/run/secrets/vapid_private_key",
      "--env",
      `JB_VAPID_PUBLIC_KEY=${vapid.publicKey}`,
      "--env",
      "JB_VAPID_SUBJECT=mailto:smoke@example.com",
    );
  } else {
    args.push("--env", "JB_ALLOW_DEV_BOOTSTRAP=true");
  }
  args.push(image);
  await docker(args);
  const published = await docker(["port", name, "8787/tcp"]);
  const match = published.trim().match(/127\.0\.0\.1:(\d+)$/);
  if (!match) {
    throw new Error("CONTAINER_SMOKE_PORT_UNAVAILABLE");
  }
  return `http://127.0.0.1:${match[1]}`;
}

async function assertDevelopmentBootstrapDisabled(origin) {
  const response = await fetch(`${origin}/api/dev/desktop-session`, {
    method: "POST",
  });
  if (response.status !== 404) {
    throw new Error(
      `CONTAINER_SMOKE_PRODUCTION_BOOTSTRAP_${response.status}`,
    );
  }
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // The container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("CONTAINER_SMOKE_READINESS_TIMEOUT");
}

async function createDevelopmentAppSession(origin) {
  const response = await fetch(`${origin}/api/dev/desktop-session`, {
    method: "POST",
  });
  if (response.status !== 204) {
    throw new Error(`CONTAINER_SMOKE_REQUEST_${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  const value = setCookie?.match(/(?:^|,\s*)jb_app=(jbas_[0-9a-f]{64});/u)?.[1];
  if (!value) {
    throw new Error("CONTAINER_SMOKE_APP_COOKIE_INVALID");
  }
  return `jb_app=${value}`;
}

async function assertAppSession(origin, appSessionCookie) {
  const response = await fetch(`${origin}/api/private/desktop/status`, {
    headers: { cookie: appSessionCookie },
  });
  if (!response.ok) {
    throw new Error(`CONTAINER_SMOKE_SESSION_${response.status}`);
  }
  const body = await response.json();
  if (
    body?.authenticated !== true ||
    body?.desktop?.id !== "demo-desktop"
  ) {
    throw new Error("CONTAINER_SMOKE_SESSION_BODY_INVALID");
  }
}

async function writeDesktopState(origin, appSessionCookie) {
  const heartbeat = await fetch(
    `${origin}/api/private/desktop/heartbeat`,
    {
      method: "POST",
      headers: {
        cookie: appSessionCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        lmsSessionState: "connected",
        appVersion: "container-smoke",
      }),
    },
  );
  if (!heartbeat.ok) {
    throw new Error(`CONTAINER_SMOKE_HEARTBEAT_${heartbeat.status}`);
  }

  const now = new Date();
  const attendance = await fetch(
    `${origin}/api/private/desktop/attendance-snapshot`,
    {
      method: "POST",
      headers: {
        cookie: appSessionCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attendanceDate: kstDate(now),
        cohortId: "container-smoke-cohort",
        cohortStatus: "active",
        cohortStartDate: "2026-01-01",
        cohortEndDate: "2027-12-31",
        morningChecked: true,
        eveningChecked: false,
        collectedAt: now.toISOString(),
      }),
    },
  );
  if (!attendance.ok) {
    throw new Error(
      `CONTAINER_SMOKE_ATTENDANCE_${attendance.status}`,
    );
  }
}

async function assertDesktopStatePersisted(origin, appSessionCookie) {
  const response = await fetch(
    `${origin}/api/private/desktop/dashboard`,
    { headers: { cookie: appSessionCookie } },
  );
  if (!response.ok) {
    throw new Error(
      `CONTAINER_SMOKE_DASHBOARD_${response.status}`,
    );
  }
  const body = await response.json();
  if (
    body?.desktop?.id !== "demo-desktop" ||
    body?.attendance?.status !== "available" ||
    body?.attendance?.snapshot?.sourceDeviceId !== "demo-desktop"
  ) {
    throw new Error("CONTAINER_SMOKE_DASHBOARD_BODY_INVALID");
  }
}

function kstDate(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

async function cleanupContainer(name) {
  await docker(["rm", "--force", name], true);
}

async function docker(args, tolerateFailure = false) {
  try {
    const result = await execute("docker", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (tolerateFailure) {
      return "";
    }
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(
      stderr ? `DOCKER_COMMAND_FAILED: ${stderr}` : "DOCKER_COMMAND_FAILED",
    );
  }
}
