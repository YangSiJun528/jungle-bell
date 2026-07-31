import { describe, expect, it } from "vitest";

import { notificationChannelFor } from "./notification-channel";

describe("notificationChannelFor", () => {
  it("uses the native channel inside Tauri", () => {
    expect(notificationChannelFor("desktop", true)).toBe("native");
  });

  it("uses Web Push for a paired browser companion", () => {
    expect(notificationChannelFor("companion", false)).toBe("web-push");
  });

  it("never registers notifications on the public web", () => {
    expect(notificationChannelFor("public", false)).toBe("none");
  });
});
