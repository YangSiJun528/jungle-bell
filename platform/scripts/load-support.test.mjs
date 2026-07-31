import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  LOAD_BUNDLE_SCHEMA_VERSION,
  cookieHeader,
  parsePositiveInteger,
  validateLoadBundle,
} from "./load-support.mjs";

describe("load-support", () => {
  it("accepts the versioned 200-user token bundle", () => {
    const bundle = {
      schemaVersion: LOAD_BUNDLE_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      users: Array.from({ length: 200 }, (_, index) => ({
        userId: `load-user-${index}`,
        desktopDeviceId: `load-desktop-${index}`,
        desktopCookie: `jb_app=jbas_${hex(index, 64)}`,
        mobileCookie: `jb_device=jbs_${hex(index + 1, 64)}`,
      })),
    };

    assert.equal(validateLoadBundle(bundle, { expectedUsers: 200 }), bundle);
  });

  it("rejects duplicate users, devices, and session cookies", () => {
    const entry = {
      userId: "load-user-0",
      desktopDeviceId: "load-desktop-0",
      desktopCookie: `jb_app=jbas_${"a".repeat(64)}`,
      mobileCookie: `jb_device=jbs_${"b".repeat(64)}`,
    };
    const bundle = {
      schemaVersion: LOAD_BUNDLE_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      users: [entry, { ...entry }],
    };

    assert.throws(
      () => validateLoadBundle(bundle, { expectedUsers: 2 }),
      /LOAD_BUNDLE_DUPLICATE_USER/u,
    );
  });

  it("rejects malformed or unexpected cookie names", () => {
    const bundle = {
      schemaVersion: LOAD_BUNDLE_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      users: [
        {
          userId: "load-user-0",
          desktopDeviceId: "load-desktop-0",
          desktopCookie: `session=jbas_${"a".repeat(64)}`,
          mobileCookie: `jb_device=jbs_${"b".repeat(64)}`,
        },
      ],
    };

    assert.throws(
      () => validateLoadBundle(bundle, { expectedUsers: 1 }),
      /LOAD_BUNDLE_DESKTOP_COOKIE_INVALID/u,
    );
  });

  it("parses bounded positive integers without accepting coercion", () => {
    assert.equal(parsePositiveInteger("200", "USERS", 500), 200);
    assert.throws(
      () => parsePositiveInteger("0200", "USERS", 500),
      /USERS_INVALID/u,
    );
    assert.throws(
      () => parsePositiveInteger("501", "USERS", 500),
      /USERS_INVALID/u,
    );
  });

  it("builds a cookie header only from a validated cookie pair", () => {
    assert.equal(
      cookieHeader(`jb_app=jbas_${"c".repeat(64)}`, "jb_app"),
      `jb_app=jbas_${"c".repeat(64)}`,
    );
    assert.throws(
      () =>
        cookieHeader(
          `jb_app=jbas_${"c".repeat(64)}; attacker=value`,
          "jb_app",
        ),
      /LOAD_COOKIE_INVALID/u,
    );
  });

  it("seeds desktop sessions through the atomic rotation contract", async () => {
    const source = await readFile(
      new URL("./seed-load.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /desktopSessions\.insertReplacingActive\(\{/u);
    assert.doesNotMatch(source, /desktopSessions\.insert\(\{/u);
  });
});

function hex(value, length) {
  return value.toString(16).padStart(length, "0").slice(-length);
}
