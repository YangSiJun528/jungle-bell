import { createECDH } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadVapidConfiguration } from "./config.js";

function vapidKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

describe("VAPID configuration", () => {
  it("is disabled when all VAPID variables are absent", () => {
    expect(loadVapidConfiguration({})).toBeNull();
  });

  it("accepts a complete mailto configuration", () => {
    const keys = vapidKeyPair();
    expect(
      loadVapidConfiguration({
        JB_VAPID_SUBJECT: "mailto:admin@example.com",
        JB_VAPID_PUBLIC_KEY: keys.publicKey,
        JB_VAPID_PRIVATE_KEY: keys.privateKey,
      }),
    ).toMatchObject({
      subject: "mailto:admin@example.com",
    });
  });

  it("rejects partial, malformed, and non-mailto configuration", () => {
    const keys = vapidKeyPair();
    expect(() =>
      loadVapidConfiguration({
        JB_VAPID_PUBLIC_KEY: "missing-the-rest",
      }),
    ).toThrow("VAPID_CONFIGURATION_INCOMPLETE");
    expect(() =>
      loadVapidConfiguration({
        JB_VAPID_SUBJECT: "https://example.com",
        JB_VAPID_PUBLIC_KEY: keys.publicKey,
        JB_VAPID_PRIVATE_KEY: keys.privateKey,
      }),
    ).toThrow("VAPID_SUBJECT_INVALID");
  });

  it("rejects a structurally valid but mismatched key pair", () => {
    const publicPair = vapidKeyPair();
    const privatePair = vapidKeyPair();
    expect(() =>
      loadVapidConfiguration({
        JB_VAPID_SUBJECT: "mailto:admin@example.com",
        JB_VAPID_PUBLIC_KEY: publicPair.publicKey,
        JB_VAPID_PRIVATE_KEY: privatePair.privateKey,
      }),
    ).toThrow("VAPID_KEY_PAIR_MISMATCH");
  });
});
