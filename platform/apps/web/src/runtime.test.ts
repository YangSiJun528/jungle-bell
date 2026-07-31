import { isTauri } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isDesktopRuntime } from "./runtime";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
}));

describe("desktop runtime detection", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReset();
  });

  it("uses Tauri's supported runtime detector", () => {
    vi.mocked(isTauri).mockReturnValue(true);

    expect(isDesktopRuntime()).toBe(true);
    expect(isTauri).toHaveBeenCalledOnce();
  });

  it("does not infer Tauri from private window globals", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.mocked(isTauri).mockReturnValue(false);

    expect(isDesktopRuntime()).toBe(false);

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
});
