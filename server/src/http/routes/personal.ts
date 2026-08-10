import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";
import {
  createLaundryWatch, joinLaundryQueue, publicLaundryQueueEntry, publicLaundryWatch,
  readMealPreference, updateMealPreference,
} from "../../application/personal-controls";
import type { Principal } from "../../domain/session";
import { desktopPrincipal, mobilePrincipal } from "../auth";
import {
  laundryQueueParamSchema, laundryQueueSchema, laundryWatchParamSchema, laundryWatchSchema,
  mealPreferenceSchema, validationHook,
} from "../schemas";
import type { ApiEnvironment } from "../types";

type PrincipalLoader = (context: Context<ApiEnvironment>) => Promise<Principal>;

export function registerPersonalControlRoutes(app: Hono<ApiEnvironment>): void {
  registerRole(app, "desktop", desktopPrincipal);
  registerRole(app, "mobile", mobilePrincipal);
}

function registerRole(app: Hono<ApiEnvironment>, role: "desktop" | "mobile", principalFor: PrincipalLoader): void {
  const base = `/api/${role}`;
  app.get(`${base}/meal-preferences`, async (context) => {
    const principal = await principalFor(context);
    return context.json(await readMealPreference(context.var.renewalStore, principal.userId));
  });
  app.put(`${base}/meal-preferences`, zValidator("json", mealPreferenceSchema, validationHook), async (context) => {
    const principal = await principalFor(context);
    return context.json(await updateMealPreference(
      context.var.renewalStore, principal.userId, context.req.valid("json"), Date.now(),
    ));
  });

  app.get(`${base}/laundry-watches`, async (context) => {
    const principal = await principalFor(context);
    const watches = await context.var.renewalStore.listLaundryWatches(principal.userId);
    return context.json({ watches: watches.map(publicLaundryWatch) });
  });
  app.post(`${base}/laundry-watches`, zValidator("json", laundryWatchSchema, validationHook), async (context) => {
    const principal = await principalFor(context);
    return context.json(publicLaundryWatch(await createLaundryWatch({
      store: context.var.renewalStore, userId: principal.userId,
      value: context.req.valid("json"), nowEpochMs: Date.now(),
    })), 201);
  });
  app.delete(`${base}/laundry-watches/:id`, zValidator("param", laundryWatchParamSchema, validationHook), async (context) => {
    const principal = await principalFor(context);
    if (!(await context.var.renewalStore.cancelLaundryWatch(
      principal.userId, context.req.valid("param").id, Date.now(),
    ))) return context.json({ error: "LAUNDRY_WATCH_NOT_FOUND" }, 404);
    return context.body(null, 204);
  });

  app.get(`${base}/laundry-queue`, async (context) => {
    const principal = await principalFor(context);
    const entries = await context.var.renewalStore.listLaundryQueue(principal.userId, Date.now());
    return context.json({ entries: entries.map(publicLaundryQueueEntry) });
  });
  app.post(`${base}/laundry-queue`, zValidator("json", laundryQueueSchema, validationHook), async (context) => {
    const principal = await principalFor(context);
    return context.json(publicLaundryQueueEntry(await joinLaundryQueue({
      store: context.var.renewalStore, userId: principal.userId,
      value: context.req.valid("json"), nowEpochMs: Date.now(),
    })), 201);
  });
  app.delete(`${base}/laundry-queue/:id`, zValidator("param", laundryQueueParamSchema, validationHook), async (context) => {
    const principal = await principalFor(context);
    if (!(await context.var.renewalStore.cancelLaundryQueueEntry(
      principal.userId, context.req.valid("param").id, Date.now(),
    ))) return context.json({ error: "LAUNDRY_QUEUE_ENTRY_NOT_FOUND" }, 404);
    return context.body(null, 204);
  });
}
