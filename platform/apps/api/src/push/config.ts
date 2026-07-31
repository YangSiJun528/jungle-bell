import { createECDH, timingSafeEqual } from "node:crypto";

import type { VapidConfiguration } from "./sender.js";

export function loadVapidConfiguration(
  environment: NodeJS.ProcessEnv,
): VapidConfiguration | null {
  const subject = environment.JB_VAPID_SUBJECT;
  const publicKey = environment.JB_VAPID_PUBLIC_KEY;
  const privateKey = environment.JB_VAPID_PRIVATE_KEY;
  const values = [subject, publicKey, privateKey];
  if (values.every((value) => value === undefined || value === "")) {
    return null;
  }
  if (values.some((value) => value === undefined || value === "")) {
    throw new Error("VAPID_CONFIGURATION_INCOMPLETE");
  }
  if (
    !subject!.startsWith("mailto:") ||
    !subject!.slice("mailto:".length).includes("@")
  ) {
    throw new Error("VAPID_SUBJECT_INVALID");
  }
  const publicBytes = decodeBase64Url(publicKey!);
  const privateBytes = decodeBase64Url(privateKey!);
  if (
    publicBytes.byteLength !== 65 ||
    publicBytes[0] !== 4 ||
    privateBytes.byteLength !== 32
  ) {
    throw new Error("VAPID_KEY_INVALID");
  }
  let derivedPublicKey: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateBytes);
    derivedPublicKey = ecdh.getPublicKey(undefined, "uncompressed");
  } catch {
    throw new Error("VAPID_KEY_INVALID");
  }
  if (
    derivedPublicKey.byteLength !== publicBytes.byteLength ||
    !timingSafeEqual(derivedPublicKey, publicBytes)
  ) {
    throw new Error("VAPID_KEY_PAIR_MISMATCH");
  }
  return {
    subject: subject!,
    publicKey: publicKey!,
    privateKey: privateKey!,
  };
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("VAPID_KEY_INVALID");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("VAPID_KEY_INVALID");
  }
  return decoded;
}
