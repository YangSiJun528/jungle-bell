import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { publishAttendance, readAttendance, readMobileAttendance } from "../../application/attendance";
import type { AttendancePreferenceRecord } from "../../workers/account-storage";
import { desktopPrincipal, mobilePrincipal } from "../auth";
import { attendancePreferenceSchema, attendanceSnapshotSchema, validationHook } from "../schemas";
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

  app.get("/api/desktop/attendance/preferences", async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await readPreferences(context.var.renewalStore, principal.userId));
  });
  app.put("/api/desktop/attendance/preferences", zValidator("json", attendancePreferenceSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await updatePreferences(
      context.var.renewalStore, principal.userId, context.req.valid("json"), Date.now(),
    ));
  });
  app.get("/api/mobile/attendance/preferences", async (context) => {
    const principal = await mobilePrincipal(context);
    return context.json(await readPreferences(context.var.renewalStore, principal.userId));
  });
  app.put("/api/mobile/attendance/preferences", zValidator("json", attendancePreferenceSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    return context.json(await updatePreferences(
      context.var.renewalStore, principal.userId, context.req.valid("json"), Date.now(),
    ));
  });
}

async function readPreferences(
  store: ApiEnvironment["Variables"]["renewalStore"],
  userId: string,
): Promise<AttendancePreferenceRecord> {
  return await store.getAttendancePreference(userId) ?? {
    morning: true, evening: true, skipSunday: false, skipAttendanceDate: null,
  };
}

async function updatePreferences(
  store: ApiEnvironment["Variables"]["renewalStore"],
  userId: string,
  body: {
    morning: boolean;
    evening: boolean;
    skipSunday: boolean;
    skipAttendanceDate: string | null;
  },
  now: number,
): Promise<AttendancePreferenceRecord> {
  const preference: AttendancePreferenceRecord = { ...body };
  await store.setAttendancePreference(userId, preference, now);
  return preference;
}
