import { beforeEach, describe, expect, it } from "vitest";

import {
  getMobileInstallationConfirmationCode,
  getOrCreateMobileInstallationId,
} from "./mobile-installation";

describe("mobile installation identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates one non-secret 128-bit identifier and reuses it", () => {
    const first = getOrCreateMobileInstallationId();
    const second = getOrCreateMobileInstallationId();

    expect(first).toMatch(/^jbmi_[0-9a-f]{32}$/u);
    expect(second).toBe(first);
    expect(getMobileInstallationConfirmationCode()).toBe(
      first.slice(-4).toUpperCase(),
    );
  });

  it("replaces malformed local data", () => {
    window.localStorage.setItem(
      "jungle-bell.mobile-installation-id.v1",
      "previous-account",
    );
    expect(getOrCreateMobileInstallationId()).toMatch(
      /^jbmi_[0-9a-f]{32}$/u,
    );
  });

  it("does not invent a confirmation code before an installation exists", () => {
    expect(getMobileInstallationConfirmationCode()).toBeNull();
  });
});
