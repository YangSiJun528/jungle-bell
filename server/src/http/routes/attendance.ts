import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { publishAttendance, readAttendance, readMobileAttendance } from "../../application/attendance";
import { desktopPrincipal, mobilePrincipal } from "../auth";
import { attendanceSnapshotSchema, validationHook } from "../schemas";
import type { ApiEnvironment } from "../types";

export function registerAttendanceRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/desktop/attendance", async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await readAttendance(context.var.renewalStore, principal.userId, Date.now()));
  });
  app.put("/api/desktop/attendance", zValidator("json", attendanceSnapshotSchema, validationHook), async (context) => {
    return context.json(await publishAttendance({
      store: context.var.renewalStore, principal: await desktopPrincipal(context),
      snapshot: context.req.valid("json"), nowEpochMs: Date.now(),
    }));
  });
  app.get("/api/mobile/attendance", async (context) => {
    const principal = await mobilePrincipal(context);
    return context.json(await readMobileAttendance(context.var.renewalStore, principal.userId, Date.now()));
  });

}
