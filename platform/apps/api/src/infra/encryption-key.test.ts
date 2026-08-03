import { describe, expect, it } from "vitest";

import {
  deriveEncryptionKey,
  readMasterEncryptionKey,
} from "./encryption-key.js";

describe("server encryption keys", () => {
  it("requires a canonical 32-byte base64 key in production", () => {
    const encoded = Buffer.alloc(32, 4).toString("base64");
    expect(readMasterEncryptionKey(encoded, true)).toEqual(
      Buffer.alloc(32, 4),
    );
    expect(() => readMasterEncryptionKey(undefined, true)).toThrow(
      "JB_SESSION_ENCRYPTION_KEY_REQUIRED",
    );
    expect(() => readMasterEncryptionKey("not-base64", true)).toThrow(
      "JB_SESSION_ENCRYPTION_KEY_INVALID",
    );
  });

  it("derives a stable key for encrypted pairing transport", () => {
    const master = Buffer.alloc(32, 9);
    const pairing = deriveEncryptionKey(master, "pairing-transport-v1");

    expect(pairing).toHaveLength(32);
    expect(deriveEncryptionKey(master, "pairing-transport-v1")).toEqual(
      pairing,
    );
  });
});
