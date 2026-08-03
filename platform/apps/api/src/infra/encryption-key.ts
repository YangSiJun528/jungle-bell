import { hkdfSync, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const KEY_DERIVATION_SALT = Buffer.from(
  "jungle-bell-platform-server-v1",
  "utf8",
);

export function readMasterEncryptionKey(
  encoded: string | undefined,
  production: boolean,
  variableName = "JB_SESSION_ENCRYPTION_KEY",
): Buffer {
  if (encoded === undefined || encoded.length === 0) {
    if (production) {
      throw new Error(`${variableName}_REQUIRED`);
    }
    return randomBytes(KEY_BYTES);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength !== KEY_BYTES ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error(`${variableName}_INVALID`);
  }
  return decoded;
}

export function deriveEncryptionKey(
  master: Uint8Array,
  purpose: "pairing-transport-v1",
): Buffer {
  if (master.byteLength !== KEY_BYTES) {
    throw new Error("JB_SESSION_ENCRYPTION_KEY_INVALID");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      KEY_DERIVATION_SALT,
      Buffer.from(purpose, "utf8"),
      KEY_BYTES,
    ),
  );
}
