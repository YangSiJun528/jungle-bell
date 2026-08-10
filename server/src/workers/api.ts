import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { registerApiMiddleware } from "../http/middleware";
import { registerAttendanceRoutes } from "../http/routes/attendance";
import { registerDesktopRoutes } from "../http/routes/desktop";
import { registerMobileRoutes } from "../http/routes/mobile";
import { registerNotificationRoutes } from "../http/routes/notifications";
import { registerPairingRoutes } from "../http/routes/pairings";
import { registerPersonalControlRoutes } from "../http/routes/personal";
import { registerPublicRoutes } from "../http/routes/public";
import { registerPushRoutes } from "../http/routes/push";
import type { ApiEnvironment } from "../http/types";
import { RenewalError } from "../renewal/service";
import type { ApiBindings } from "../http/types";
import { D1_GATEWAY_PATH, handleD1Gateway } from "./d1-gateway";
import { handleR2Gateway, R2_GATEWAY_PATH } from "./r2-gateway";

const apiLogger = getLogger(["jungle-bell", "api-worker"]);

export const app = new Hono<ApiEnvironment>();

registerApiMiddleware(app);
app.all(D1_GATEWAY_PATH, (context) => handleD1Gateway(context.req.raw, context.env));
app.all(R2_GATEWAY_PATH, (context) => handleR2Gateway(context.req.raw, context.env));
app.get("/", (context) => context.redirect("/dashboard.html", 308));
app.get("/blog", (context) => context.redirect("/blog/index.html", 308));
app.get("/blog/", (context) => context.redirect("/blog/index.html", 308));
registerPublicRoutes(app);
registerDesktopRoutes(app);
registerMobileRoutes(app);
registerPairingRoutes(app);
registerPersonalControlRoutes(app);
registerAttendanceRoutes(app);
registerNotificationRoutes(app);
registerPushRoutes(app);

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));
app.onError((error, context) => {
  if (error instanceof RenewalError) return context.json({ error: error.code }, error.status);
  apiLogger.error("API request failed", {
    method: context.req.method,
    path: context.req.path,
    error: error.message,
  });
  return context.json({ error: "INTERNAL_ERROR" }, 500);
});

export default {
  fetch(request: Request, env: ApiBindings, context: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<ApiBindings>;
