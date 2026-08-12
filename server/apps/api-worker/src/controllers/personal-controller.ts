import { zValidator } from "@hono/zod-validator";
import {
  attendancePreferencesSchema,
  attendancePreferencesV2Schema,
  laundryQueueIdSchema,
  laundryQueueInputSchema,
  laundryWatchIdSchema,
  laundryWatchInputSchema,
  mealPreferencesInputSchema,
} from "@jungle-bell/backend-common/contracts/personal";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Principal } from "../domain/session";
import { desktopPrincipal, mobilePrincipal } from "./auth";
import { validationHook } from "./schemas";
import type { ApiEnvironment } from "./types";

type PrincipalLoader = (context: Context<ApiEnvironment>) => Promise<Principal>;

export function createPersonalController(): Hono<ApiEnvironment> {
  return new Hono<ApiEnvironment>()
    .route("/api/desktop", personalRoutes(desktopPrincipal))
    .route("/api/mobile", personalRoutes(mobilePrincipal));
}

function personalRoutes(principalFor: PrincipalLoader): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/attendance/preferences", async (context) => {
    const principal = await principalFor(context);
    return context.json(await context.var.services.personal.readLegacyAttendancePreferences(principal.userId));
  });
  app.put(
    "/attendance/preferences",
    zValidator("json", attendancePreferencesSchema, validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return context.json(await context.var.services.personal.updateLegacyAttendancePreferences(
        principal.userId,
        context.req.valid("json"),
        Date.now(),
      ));
    },
  );
  app.get("/v2/attendance/preferences", async (context) => {
    const principal = await principalFor(context);
    return context.json(await context.var.services.personal.readAttendancePreferences(principal.userId));
  });
  app.put(
    "/v2/attendance/preferences",
    zValidator("json", attendancePreferencesV2Schema, validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return context.json(await context.var.services.personal.updateAttendancePreferences(
        principal.userId,
        context.req.valid("json"),
        Date.now(),
      ));
    },
  );
  app.get("/meal-preferences", async (context) => {
    const principal = await principalFor(context);
    return context.json(await context.var.services.personal.readMealPreferences(principal.userId));
  });
  app.put(
    "/meal-preferences",
    zValidator("json", mealPreferencesInputSchema, validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return context.json(await context.var.services.personal.updateMealPreferences(
        principal.userId,
        context.req.valid("json"),
        Date.now(),
      ));
    },
  );
  app.get("/laundry-watches", async (context) => {
    const principal = await principalFor(context);
    return context.json({ watches: await context.var.services.personal.listLaundryWatches(principal.userId) });
  });
  app.post(
    "/laundry-watches",
    zValidator("json", laundryWatchInputSchema, validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return context.json(await context.var.services.personal.createLaundryWatch(
        principal.userId,
        context.req.valid("json"),
        Date.now(),
      ), 201);
    },
  );
  app.delete(
    "/laundry-watches/:id",
    zValidator("param", z.strictObject({ id: laundryWatchIdSchema }), validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return await context.var.services.personal.cancelLaundryWatch(
        principal.userId,
        context.req.valid("param").id,
        Date.now(),
      ) ? context.body(null, 204) : context.json({ error: "LAUNDRY_WATCH_NOT_FOUND" }, 404);
    },
  );
  app.get("/laundry-queue", async (context) => {
    const principal = await principalFor(context);
    return context.json({ entries: await context.var.services.personal.listLaundryQueue(principal.userId, Date.now()) });
  });
  app.post(
    "/laundry-queue",
    zValidator("json", laundryQueueInputSchema, validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return context.json(await context.var.services.personal.joinLaundryQueue(
        principal.userId,
        context.req.valid("json"),
        Date.now(),
      ), 201);
    },
  );
  app.delete(
    "/laundry-queue/:id",
    zValidator("param", z.strictObject({ id: laundryQueueIdSchema }), validationHook),
    async (context) => {
      const principal = await principalFor(context);
      return await context.var.services.personal.leaveLaundryQueue(
        principal.userId,
        context.req.valid("param").id,
        Date.now(),
      ) ? context.body(null, 204) : context.json({ error: "LAUNDRY_QUEUE_ENTRY_NOT_FOUND" }, 404);
    },
  );
  return app;
}
