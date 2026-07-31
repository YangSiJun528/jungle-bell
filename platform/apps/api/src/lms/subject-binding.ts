import { createHash } from "node:crypto";

const SUBJECT_BINDING_DOMAIN = "jungle-bell:lms-subject-binding:v1\0";

/**
 * Proves that the LMS subject observed by the persistent desktop WebView is
 * the same subject that the server verifies with its one-shot `/api/v2/me`
 * request. The raw LMS subject never crosses this boundary.
 */
export function computeLmsSubjectBinding(
  desktopDeviceId: string,
  subject: string,
): string {
  return createHash("sha256")
    .update(SUBJECT_BINDING_DOMAIN, "utf8")
    .update(desktopDeviceId, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}
