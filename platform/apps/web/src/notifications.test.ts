import { invoke } from "@tauri-apps/api/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sendLocalTestNotification } from "./notifications";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("local notification delivery", () => {
  const originalServiceWorker = Object.getOwnPropertyDescriptor(
    navigator,
    "serviceWorker",
  );

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceWorker === undefined) {
      Reflect.deleteProperty(navigator, "serviceWorker");
    } else {
      Object.defineProperty(
        navigator,
        "serviceWorker",
        originalServiceWorker,
      );
    }
  });

  it("uses the app-owned native IPC command on desktop", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await expect(sendLocalTestNotification("native")).resolves.toBe("sent");
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "send_native_test_notification",
    );
  });

  it("reports a rejected native notification without leaking the error", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("native notification failed"));

    await expect(sendLocalTestNotification("native")).resolves.toBe("denied");
  });

  it("does not display a Web notification from an ordinary browser grant", async () => {
    const showNotification = configureWebNotificationEnvironment(false);

    await expect(
      sendLocalTestNotification("web-push"),
    ).resolves.toBe("unsupported");
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("displays the local test only inside an installed eligible PWA", async () => {
    const showNotification = configureWebNotificationEnvironment(true);

    await expect(
      sendLocalTestNotification("web-push"),
    ).resolves.toBe("sent");
    expect(showNotification).toHaveBeenCalledWith(
      "Jungle Bell 테스트",
      expect.objectContaining({ tag: "jungle-bell-test" }),
    );
  });
});

function configureWebNotificationEnvironment(standalone: boolean) {
  const showNotification = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ showNotification }),
    },
  });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: standalone })),
  );
  vi.stubGlobal("PushManager", class PushManager {});
  vi.stubGlobal("Notification", {
    permission: "granted",
    requestPermission: vi.fn(async () => "granted"),
  });
  return showNotification;
}
