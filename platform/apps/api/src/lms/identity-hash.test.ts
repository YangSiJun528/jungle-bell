import { describe, expect, it } from "vitest";

import { computeLmsIdentitySha256 } from "./identity-hash.js";

describe("LMS identity SHA-256", () => {
  it("hashes the immutable LMS ID without a secret or deployment-specific salt", () => {
    expect(computeLmsIdentitySha256("lms-user-42")).toBe(
      "13e60a3d882e05a7fde8c00a0f84a89daae68e1640e5b45192edefbf3693158e",
    );
  });

  it("is stable for the same LMS ID and distinct from the installation binding", () => {
    const first = computeLmsIdentitySha256("lms-user-42");
    expect(computeLmsIdentitySha256("lms-user-42")).toBe(first);
    expect(computeLmsIdentitySha256("lms-user-43")).not.toBe(first);
    expect(first).not.toBe(
      "32bb7cb9cdb6aaee5104ac2626e27d402f5825e9b3e7283bd33dfcd1bcae3424",
    );
  });

  it.each(["", " lms-user-42", "lms-user-42 ", "line\nbreak"])(
    "rejects an invalid immutable LMS ID: %j",
    (subject) => {
      expect(() => computeLmsIdentitySha256(subject)).toThrow(
        "LMS_IDENTITY_SUBJECT_INVALID",
      );
    },
  );
});
