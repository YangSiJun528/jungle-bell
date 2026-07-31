import { isTauri } from "@tauri-apps/api/core";

export function isDesktopRuntime(): boolean {
  return isTauri();
}
