import type { SurfaceKind } from "./surface";

export type NotificationChannel = "native" | "web-push" | "none";

export function notificationChannelFor(
  surface: SurfaceKind,
  runningInTauri: boolean,
): NotificationChannel {
  if (surface === "desktop" && runningInTauri) {
    return "native";
  }
  if (surface === "companion") {
    return "web-push";
  }
  return "none";
}
