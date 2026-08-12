import type { Context, Hono } from "hono";
import {
  createPersonalRoutes,
  type PersonalRouteHandlers,
} from "../contracts/personal";
import {
  createLaundryWatch, joinLaundryQueue, publicLaundryQueueEntry, publicLaundryWatch,
  readMealPreference, updateMealPreference,
} from "../../application/personal-controls";
import type { Principal } from "../../domain/session";
import type { AttendancePreferenceRecord } from "../../workers/account-storage";
import { desktopPrincipal, mobilePrincipal } from "../auth";
import { apiErrorHandler } from "../errors";
import type { ApiEnvironment } from "../types";

type PrincipalLoader = (context: Context<ApiEnvironment>) => Promise<Principal>;

function apiContext(context: Context): Context<ApiEnvironment> {
  return context as unknown as Context<ApiEnvironment>;
}

function handlers(principalFor: PrincipalLoader): PersonalRouteHandlers {
  return {
    async getAttendancePreferences(context) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return readPreferences(api.var.renewalStore, principal.userId);
    },
    async updateAttendancePreferences(context, input) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return updatePreferences(api.var.renewalStore, principal.userId, input, Date.now());
    },
    async getMealPreferences(context) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return readMealPreference(api.var.renewalStore, principal.userId);
    },
    async updateMealPreferences(context, input) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return updateMealPreference(api.var.renewalStore, principal.userId, input, Date.now());
    },
    async listLaundryWatches(context) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      const watches = await api.var.renewalStore.listLaundryWatches(principal.userId);
      return watches.map(publicLaundryWatch);
    },
    async createLaundryWatch(context, input) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return publicLaundryWatch(await createLaundryWatch({
        store: api.var.renewalStore,
        userId: principal.userId,
        value: input,
        nowEpochMs: Date.now(),
      }));
    },
    async deleteLaundryWatch(context, id) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return api.var.renewalStore.cancelLaundryWatch(principal.userId, id, Date.now());
    },
    async listLaundryQueue(context) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      const entries = await api.var.renewalStore.listLaundryQueue(principal.userId, Date.now());
      return entries.map(publicLaundryQueueEntry);
    },
    async joinLaundryQueue(context, input) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return publicLaundryQueueEntry(await joinLaundryQueue({
        store: api.var.renewalStore,
        userId: principal.userId,
        value: input,
        nowEpochMs: Date.now(),
      }));
    },
    async leaveLaundryQueue(context, id) {
      const api = apiContext(context);
      const principal = await principalFor(api);
      return api.var.renewalStore.cancelLaundryQueueEntry(principal.userId, id, Date.now());
    },
  };
}

export const desktopPersonalRoutes = createPersonalRoutes(handlers(desktopPrincipal), apiErrorHandler);
export const mobilePersonalRoutes = createPersonalRoutes(handlers(mobilePrincipal), apiErrorHandler);

export function registerPersonalControlRoutes(app: Hono<ApiEnvironment>): void {
  app.route("/api/desktop", desktopPersonalRoutes);
  app.route("/api/mobile", mobilePersonalRoutes);
}

async function readPreferences(
  store: ApiEnvironment["Variables"]["renewalStore"],
  userId: string,
): Promise<AttendancePreferenceRecord> {
  return await store.getAttendancePreference(userId) ?? {
    morning: true,
    evening: true,
    skipSunday: false,
    skipAttendanceDate: null,
  };
}

async function updatePreferences(
  store: ApiEnvironment["Variables"]["renewalStore"],
  userId: string,
  body: AttendancePreferenceRecord,
  now: number,
): Promise<AttendancePreferenceRecord> {
  const preference: AttendancePreferenceRecord = { ...body };
  await store.setAttendancePreference(userId, preference, now);
  return preference;
}
