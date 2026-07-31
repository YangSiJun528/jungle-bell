import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLocalDesktopSession,
  startLmsLogin,
} from "./desktop-bridge";
import { isDesktopRuntime } from "./runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./runtime", () => ({
  isDesktopRuntime: vi.fn(),
}));

describe("desktop native bridge", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(isDesktopRuntime).mockReset();
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
  });

  it("invokes the fixed login command without arguments", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await startLmsLogin();

    expect(invoke).toHaveBeenCalledExactlyOnceWith("start_lms_login");
  });

  it("invokes the fixed local-session cleanup command", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await clearLocalDesktopSession();

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "clear_local_desktop_session",
    );
  });

  it("refuses to invoke native commands from an ordinary web page", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);

    await expect(startLmsLogin()).rejects.toThrow(
      "DESKTOP_RUNTIME_REQUIRED",
    );
    await expect(clearLocalDesktopSession()).rejects.toThrow(
      "DESKTOP_RUNTIME_REQUIRED",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
