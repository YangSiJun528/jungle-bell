import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { desktopPrincipal, mobilePrincipal } from "./auth";
import { attendanceSnapshotSchema, validationHook } from "./schemas";
import type { ApiEnvironment } from "./types";

export function createAttendanceController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/api/desktop/attendance", async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await context.var.services.attendance.readDesktop(principal.userId, Date.now()));
  });
  app.put("/api/desktop/attendance", zValidator("json", attendanceSnapshotSchema, validationHook), async (context) => {
    return context.json(await context.var.services.attendance.publish(
      await desktopPrincipal(context),
      context.req.valid("json"),
      Date.now(),
    ));
  });
  app.get("/api/mobile/attendance", async (context) => {
    const principal = await mobilePrincipal(context);
    return context.json(await context.var.services.attendance.readMobile(principal.userId, Date.now()));
  });
  return app;
}
