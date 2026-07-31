import { describe, expect, it } from "vitest";

import { computeLmsSubjectBinding } from "./subject-binding.js";

describe("LMS subject binding", () => {
  it("uses the protocol's domain-separated SHA-256 vector", () => {
    expect(
      computeLmsSubjectBinding(
        "550e8400-e29b-41d4-a716-446655440000",
        "lms-user-42",
      ),
    ).toBe(
      "32bb7cb9cdb6aaee5104ac2626e27d402f5825e9b3e7283bd33dfcd1bcae3424",
    );
  });

  it("binds both the desktop installation and LMS subject", () => {
    const first = computeLmsSubjectBinding(
      "550e8400-e29b-41d4-a716-446655440000",
      "lms-user-42",
    );
    expect(
      computeLmsSubjectBinding(
        "650e8400-e29b-41d4-a716-446655440000",
        "lms-user-42",
      ),
    ).not.toBe(first);
    expect(
      computeLmsSubjectBinding(
        "550e8400-e29b-41d4-a716-446655440000",
        "lms-user-43",
      ),
    ).not.toBe(first);
  });
});
