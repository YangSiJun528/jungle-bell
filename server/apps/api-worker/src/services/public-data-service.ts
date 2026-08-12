import { toPublicLaundryVersion, type LaundryVersion } from "@jungle-bell/backend-common/collection/laundry";
import {
  type ArchivedMealPost,
  currentWeeklyMealMenu,
  weeklyMealMenu,
  withMealPostContentSha,
  type MealsVersion,
  type WeeklyMealMenu,
} from "@jungle-bell/backend-common/collection/meals";
import { projectLaundry } from "@jungle-bell/backend-common/collection/projection";
import { compactUtcMinute, floorToMinute, minuteEpoch, parseCompactUtcMinute } from "@jungle-bell/backend-common/collection/time";
import {
  SOURCE_NAMES,
  type LaundryEvent,
  type MinuteObservation,
  type SourceName,
  type SourceState,
} from "@jungle-bell/backend-common/collection/types";
import {
  decodeMealHistoryCursor,
  encodeMealHistoryCursor,
  type MealHistoryCursor,
} from "@jungle-bell/backend-common/domain/meal-history";
import { withLaundryCapacity } from "./laundry-capacity";

const MEAL_HISTORY_PAGE_SIZE = 30;
const MAX_SOURCE_AGE_MS: Record<SourceName, number> = {
  laundry: 3 * 60_000,
  "meals-include-pinned": 12 * 60_000,
  "meals-default": 12 * 60_000,
};

export type PublicDataResult<T> = { ok: true; value: T } | {
  ok: false;
  error: "NO_DATA" | "DATA_OBJECT_MISSING" | "INVALID_MINUTE" | "HISTORY_EXPIRED"
    | "OBSERVATION_NOT_FOUND" | "VERSION_NOT_FOUND" | "ASSET_NOT_FOUND";
};

/** Read operations required by public-data use cases, owned by their client. */
export interface PublicDataStorage {
  readAllStates(): Promise<SourceState[]>;
  readState(source: SourceName): Promise<SourceState | null>;
  readJson<T>(key: string): Promise<T | null>;
  readObservation(source: SourceName, minute: number): Promise<MinuteObservation | null>;
  listLaundryEvents(since: string | null, limit: number): Promise<LaundryEvent[]>;
  listMealPosts(before: MealHistoryCursor | null, limit: number): Promise<ArchivedMealPost[]>;
  listWeeklyMealMenus(limit: number): Promise<WeeklyMealMenu[]>;
  readObject(key: string): Promise<R2ObjectBody | null>;
}

export interface PublicDataClock {
  now(): Date;
}

const SYSTEM_CLOCK: PublicDataClock = { now: () => new Date() };

/** Public read model service. All D1/R2 access is contained behind this boundary. */
export class PublicDataService {
  constructor(
    private readonly storage: PublicDataStorage,
    private readonly clock: PublicDataClock = SYSTEM_CLOCK,
  ) {}

  async health(nowEpochMs: number) {
    const states = await this.storage.readAllStates();
    const degraded = states.length !== SOURCE_NAMES.length || states.some((state) =>
      !state.lastSuccessAt || nowEpochMs - Date.parse(state.lastSuccessAt) > MAX_SOURCE_AGE_MS[state.source]
      || state.consecutiveFailures >= 3);
    return {
      degraded,
      body: {
        status: degraded ? "DEGRADED" as const : "OK" as const,
        checkedAt: new Date(nowEpochMs).toISOString(),
        sources: states,
      },
    };
  }

  async status() {
    return { asOf: currentCacheSlice(this.clock.now()).toISOString(), sources: await this.storage.readAllStates() };
  }

  async laundryHead(): Promise<PublicDataResult<SourceState>> {
    const state = await this.storage.readState("laundry");
    return state ? { ok: true, value: state } : { ok: false, error: "NO_DATA" };
  }

  async laundry(): Promise<PublicDataResult<ReturnType<typeof withLaundryCapacity>>> {
    const state = await this.storage.readState("laundry");
    if (!state?.lastNormalizedKey) return { ok: false, error: "NO_DATA" };
    const version = await this.storage.readJson<LaundryVersion>(state.lastNormalizedKey)
      ?? await this.storage.readJson<LaundryVersion>("latest/laundry.json");
    if (!version) return { ok: false, error: "DATA_OBJECT_MISSING" };
    return {
      ok: true,
      value: withLaundryCapacity(projectLaundry(version, state, currentCacheSlice(this.clock.now()), false)),
    };
  }

  laundryMinuteRedirect(time: string): string {
    return `/api/public/laundry/minutes/${compactUtcMinute(floorToMinute(new Date(time)))}`;
  }

  async laundryAtMinute(minute: string, nowEpochMs: number): Promise<PublicDataResult<{
    minute: string;
    observation: NonNullable<Awaited<ReturnType<PublicDataStorage["readObservation"]>>>;
    data: ReturnType<typeof withLaundryCapacity> | null;
  }>> {
    const requested = parseCompactUtcMinute(minute);
    if (!requested) return { ok: false, error: "INVALID_MINUTE" };
    const observation = await this.storage.readObservation("laundry", minuteEpoch(requested));
    if (!observation) {
      return requested.getTime() < nowEpochMs - 90 * 24 * 60 * 60_000
        ? { ok: false, error: "HISTORY_EXPIRED" }
        : { ok: false, error: "OBSERVATION_NOT_FOUND" };
    }
    if (!observation.normalizedKey) return { ok: true, value: { minute, observation, data: null } };
    const version = await this.storage.readJson<LaundryVersion>(observation.normalizedKey);
    if (!version) return { ok: false, error: "DATA_OBJECT_MISSING" };
    return {
      ok: true,
      value: {
        minute,
        observation,
        data: withLaundryCapacity(projectLaundry(
          version,
          historicalState(observation),
          new Date(observation.collectedAt),
          true,
        )),
      },
    };
  }

  async laundryVersion(sha: string): Promise<PublicDataResult<ReturnType<typeof toPublicLaundryVersion>>> {
    const version = await this.storage.readJson<LaundryVersion>(`versions/laundry/${sha}.json`);
    return version
      ? { ok: true, value: toPublicLaundryVersion(version) }
      : { ok: false, error: "VERSION_NOT_FOUND" };
  }

  async laundryEvents(since: string | null, limit: number) {
    return { events: await this.storage.listLaundryEvents(since, limit) };
  }

  async meals(requestUrl: string): Promise<PublicDataResult<unknown>> {
    const now = this.clock.now();
    const state = await this.storage.readState("meals-include-pinned");
    if (!state?.lastNormalizedKey) return { ok: false, error: "NO_DATA" };
    const stored = await this.storage.readJson<MealsVersion>(state.lastNormalizedKey)
      ?? await this.storage.readJson<MealsVersion>("latest/meals.json");
    if (!stored) return { ok: false, error: "DATA_OBJECT_MISSING" };
    const version = await withContentShas(stored);
    const recentMenus = await this.storage.listMealPosts(null, MEAL_HISTORY_PAGE_SIZE);
    const archived = await this.storage.listWeeklyMealMenus(100);
    const current = (await Promise.all(version.pinnedMenus.map((post) => weeklyMealMenu(post, version.observedAt))))
      .filter((menu): menu is WeeklyMealMenu => menu !== null);
    const weeklyMenus = [...new Map([...archived, ...current].map((menu) => [menu.weekKey, menu])).values()]
      .sort((left, right) => right.weekKey.localeCompare(left.weekKey));
    const currentWeekly = currentWeeklyMealMenu(weeklyMenus, now);
    const last = recentMenus.at(-1);
    return {
      ok: true,
      value: {
        asOf: currentCacheSlice(now).toISOString(),
        lastCheckedAt: state.lastSuccessAt,
        data: {
          ...withAssetUrls(version, requestUrl),
          currentWeeklyMenu: {
            ...currentWeekly,
            post: currentWeekly.post ? withPostAssetUrls(currentWeekly.post, requestUrl) : null,
          },
          recentMenus: recentMenus.map((post) => withPostAssetUrls(post, requestUrl)),
          weeklyMenus: weeklyMenus.map((menu) => ({ ...menu, post: withPostAssetUrls(menu.post, requestUrl) })),
          historyNextBefore: recentMenus.length === MEAL_HISTORY_PAGE_SIZE && last
            ? encodeMealHistoryCursor(last)
            : null,
        },
      },
    };
  }

  async mealHistory(encodedBefore: string | undefined, limit: number, requestUrl: string) {
    const before = encodedBefore ? decodeMealHistoryCursor(encodedBefore) : null;
    if (encodedBefore && !before) throw new Error("Validated meal history cursor could not be decoded");
    const posts = await this.storage.listMealPosts(before, limit);
    const last = posts.at(-1);
    return {
      posts: posts.map((post) => withPostAssetUrls(post, requestUrl)),
      nextBefore: posts.length === limit && last ? encodeMealHistoryCursor(last) : null,
    };
  }

  async asset(asset: string): Promise<PublicDataResult<{ sha: string; extension: string; object: R2ObjectBody }>> {
    const match = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(asset);
    if (!match?.[1] || !match[2]) throw new Error("Validated asset parameter did not match");
    const object = await this.storage.readObject(`assets/${match[1].slice(0, 2)}/${match[1]}.${match[2]}`);
    return object
      ? { ok: true, value: { sha: match[1], extension: match[2], object } }
      : { ok: false, error: "ASSET_NOT_FOUND" };
  }
}

function currentCacheSlice(reference: Date): Date {
  return new Date(Math.floor(reference.getTime() / 30_000) * 30_000);
}

function historicalState(
  observation: NonNullable<Awaited<ReturnType<PublicDataStorage["readObservation"]>>>,
): SourceState {
  return {
    source: "laundry",
    lastAttemptAt: observation.collectedAt,
    lastSuccessAt: observation.status === "SUCCESS" ? observation.collectedAt : null,
    lastResponseSha: observation.versionSha,
    lastRawKey: observation.rawKey,
    lastNormalizedKey: observation.normalizedKey,
    versionFirstSeenAt: observation.versionFirstSeenAt,
    consecutiveFailures: observation.status === "SUCCESS" ? 0 : 1,
    lastError: observation.error,
  };
}

function withPostAssetUrls<T extends MealsVersion["dailyMenus"][number]>(post: T, requestUrl: string): T {
  const origin = new URL(requestUrl).origin;
  return {
    ...post,
    images: post.images.map((image) => ({
      ...image,
      url: `${origin}/api/public/assets/${image.sha}.${image.extension}`,
    })),
  };
}

function withAssetUrls(meals: MealsVersion, requestUrl: string): MealsVersion {
  const mapPost = (post: MealsVersion["pinnedMenus"][number]) => withPostAssetUrls(post, requestUrl);
  return {
    ...meals,
    pinnedMenus: meals.pinnedMenus.map(mapPost),
    dailyMenus: meals.dailyMenus.map(mapPost),
    otherPosts: meals.otherPosts.map(mapPost),
  };
}

async function withContentShas(meals: MealsVersion): Promise<MealsVersion> {
  return {
    ...meals,
    schemaVersion: 2,
    pinnedMenus: await Promise.all(meals.pinnedMenus.map(withMealPostContentSha)),
    dailyMenus: await Promise.all(meals.dailyMenus.map(withMealPostContentSha)),
    otherPosts: await Promise.all(meals.otherPosts.map(withMealPostContentSha)),
  };
}
