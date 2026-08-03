import { invoke } from "@tauri-apps/api/core";

import type { NotificationChannel } from "./notification-channel";
import {
  requestWebPushPermissionFromUserGesture,
  WebPushClientError,
} from "./web-push/capability";

export async function sendLocalTestNotification(
  channel: NotificationChannel,
): Promise<"sent" | "denied" | "unsupported"> {
  if (channel === "native") {
    try {
      await invoke("send_native_test_notification");
      return "sent";
    } catch {
      return "denied";
    }
  }

  if (
    channel !== "web-push" ||
    !("serviceWorker" in navigator) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }

  let permission: NotificationPermission;
  try {
    permission = await requestWebPushPermissionFromUserGesture();
  } catch (error) {
    if (error instanceof WebPushClientError) {
      return "unsupported";
    }
    throw error;
  }
  if (permission !== "granted") {
    return "denied";
  }

  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification("Jungle Bell 테스트", {
    body: "모바일 알림 연결이 정상입니다.",
    icon: "/icon.svg",
    tag: "jungle-bell-test",
  });
  return "sent";
}

export function registerPwaServiceWorker(runningInTauri: boolean): void {
  if (
    runningInTauri ||
    !("serviceWorker" in navigator) ||
    window.location.protocol === "file:"
  ) {
    return;
  }

  window.addEventListener("load", () => {
    void (async () => {
      try {
        const registered = await navigator.serviceWorker.register(
          "/sw.js",
          { scope: "/" },
        );
        const readyRegistration = registered.active
          ? registered
          : await navigator.serviceWorker.ready;
        const activeWorker =
          navigator.serviceWorker.controller ??
          readyRegistration.active;
        activeWorker?.postMessage({ type: "jungle-bell-app-open" });
      } catch {
        // Installation and reconciliation are retried on a later app open.
      }
    })();
  });
}
