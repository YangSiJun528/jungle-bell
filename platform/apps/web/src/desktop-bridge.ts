import { invoke } from "@tauri-apps/api/core";

import { isDesktopRuntime } from "./runtime";

export async function startLmsLogin(): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("DESKTOP_RUNTIME_REQUIRED");
  }
  await invoke("start_lms_login");
}

export async function clearLocalDesktopSession(): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("DESKTOP_RUNTIME_REQUIRED");
  }
  await invoke("clear_local_desktop_session");
}
