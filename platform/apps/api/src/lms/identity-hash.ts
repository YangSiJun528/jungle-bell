import { createHash } from "node:crypto";

const MAX_LMS_ID_BYTES = 128;

/**
 * Canonical cross-installation user key. The LMS ID is already validated by
 * the one-shot `/api/v2/me` response; this guard prevents accidental input
 * normalization from splitting or merging internal users.
 */
export function computeLmsIdentitySha256(subject: string): string {
  if (
    subject.length === 0 ||
    subject.trim() !== subject ||
    Buffer.byteLength(subject, "utf8") > MAX_LMS_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(subject)
  ) {
    throw new TypeError("LMS_IDENTITY_SUBJECT_INVALID");
  }
  return createHash("sha256").update(subject, "utf8").digest("hex");
}
