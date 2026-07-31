import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { registerPwaServiceWorker } from "./notifications";
import { isDesktopRuntime } from "./runtime";
import "./styles.css";

const runningInTauri = isDesktopRuntime();
registerPwaServiceWorker(runningInTauri);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App tauri={runningInTauri} />
  </StrictMode>,
);
