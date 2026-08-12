import { Hono } from "hono";
import { createAttendanceController } from "./controllers/attendance-controller";
import { createDesktopController } from "./controllers/desktop-controller";
import { apiErrorHandler } from "./controllers/errors";
import { registerApiMiddleware } from "./controllers/middleware";
import { createMobileController } from "./controllers/mobile-controller";
import { createNotificationController } from "./controllers/notification-controller";
import { createPairingController } from "./controllers/pairing-controller";
import { createPersonalController } from "./controllers/personal-controller";
import { createPublicController } from "./controllers/public-controller";
import { createPushController } from "./controllers/push-controller";
import type { ApiBindings, ApiEnvironment } from "./controllers/types";
import { D1_GATEWAY_PATH, handleD1Gateway } from "./storage/cloudflare/d1-gateway";
import { handleR2Gateway, R2_GATEWAY_PATH } from "./storage/cloudflare/r2-gateway";

export const app = new Hono<ApiEnvironment>();

registerApiMiddleware(app);
app.all(D1_GATEWAY_PATH, (context) => handleD1Gateway(context.req.raw, context.env));
app.all(R2_GATEWAY_PATH, (context) => handleR2Gateway(context.req.raw, context.env));
app.get("/", (context) => context.redirect("/dashboard.html", 308));
app.get("/blog", (context) => context.redirect("/blog/index.html", 308));
app.get("/blog/", (context) => context.redirect("/blog/index.html", 308));
app.route("/", createPublicController());
app.route("/", createDesktopController());
app.route("/", createMobileController());
app.route("/", createPairingController());
app.route("/", createPersonalController());
app.route("/", createAttendanceController());
app.route("/", createNotificationController());
app.route("/", createPushController());

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));
app.onError(apiErrorHandler);

export default {
  fetch(request: Request, env: ApiBindings, context: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<ApiBindings>;
