import { getLogger } from "@logtape/logtape";
import { canonicalJsonSha256, sha256Bytes } from "./hash";
import { fetchBinary, fetchJson } from "./http";
import { allowedMealMediaHosts, MAX_MEAL_IMAGE_BYTES, rasterImageContentType } from "./media";
import { normalizeLaundry, type LaundryVersion } from "./laundry";
import {
  mealImageExtension,
  normalizeMeals,
  type MealImageAsset,
  type MealImageCandidate,
  type MealPost,
} from "./meals";
import {
  floorToMinute,
  minuteEpoch,
  snapshotPath,
} from "./time";
import type {
  CollectAllResult,
  CollectionCommit,
  CollectorOptions,
  CollectorStorage,
  JsonHttpResponse,
  MinuteObservation,
  SourceName,
  SourceState,
} from "./types";
import { SOURCE_NAMES } from "./types";

const logger = getLogger(["jungle-bell", "collector"]);
const MAX_TIMING_CONTINUITY_GAP_MS = 2 * 60_000;

interface MediaMapping extends MealImageAsset {
  archivedAt: string;
}

interface ChangedArtifacts {
  normalizedKey: string | null;
  laundryEvents?: CollectionCommit["laundryEvents"];
  mealPosts?: MealPost[];
  mealObservedAt?: string;
}

function occurrenceId(observedAt: string): string {
  return observedAt.replaceAll(/[-:.]/g, "");
}

function diagnosticCodeOf(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)) return error.name;
  return "UnknownError";
}

const PUBLIC_COLLECTION_FAILURE = "COLLECTION_FAILED";

function emptyState(source: SourceName): SourceState {
  return {
    source,
    lastAttemptAt: new Date(0).toISOString(),
    lastSuccessAt: null,
    lastResponseSha: null,
    lastRawKey: null,
    lastNormalizedKey: null,
    versionFirstSeenAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };
}

function hasTimingContinuity(state: SourceState, fetchedAt: string): boolean {
  if (!state.lastSuccessAt || state.lastError) return false;
  const gap = Date.parse(fetchedAt) - Date.parse(state.lastSuccessAt);
  return gap >= 0 && gap <= MAX_TIMING_CONTINUITY_GAP_MS;
}

function minuteObservation(
  source: SourceName,
  scheduledAt: Date,
  response: JsonHttpResponse,
  state: SourceState,
  changed: boolean,
): MinuteObservation {
  return {
    source,
    minuteEpoch: minuteEpoch(scheduledAt),
    scheduledAt: scheduledAt.toISOString(),
    collectedAt: response.fetchedAt,
    status: "SUCCESS",
    versionSha: state.lastResponseSha,
    rawKey: state.lastRawKey,
    normalizedKey: state.lastNormalizedKey,
    versionFirstSeenAt: state.versionFirstSeenAt,
    changed,
    durationMs: response.durationMs,
    httpStatus: response.status,
    error: null,
  };
}

async function archiveMealImage(
  storage: CollectorStorage,
  options: CollectorOptions,
  candidate: MealImageCandidate,
): Promise<MealImageAsset> {
  const mappingKey = `media-map/${candidate.postId}/${candidate.mediaId}.json`;
  const existing = await storage.readJson<MediaMapping>(mappingKey);
  if (existing?.sourceUrl === candidate.sourceUrl && await storage.objectExists(existing.objectKey)) {
    const { archivedAt: _archivedAt, ...asset } = existing;
    return asset;
  }

  const response = await fetchBinary(candidate.sourceUrl, {
    timeoutMs: options.requestTimeoutMs,
    retries: options.requestRetries,
    headers: { "User-Agent": options.userAgent },
    allowedHosts: allowedMealMediaHosts(),
    maxBytes: MAX_MEAL_IMAGE_BYTES,
  });
  const contentType = rasterImageContentType(response.body);
  if (!contentType) throw new Error(`Media ${candidate.mediaId} did not contain a supported raster image`);
  if (response.contentType !== "application/octet-stream" && response.contentType !== contentType) {
    throw new Error(`Media ${candidate.mediaId} content type did not match its file signature`);
  }
  const sha = await sha256Bytes(response.body);
  const extension = mealImageExtension(contentType, candidate.filename);
  const objectKey = `assets/${sha.slice(0, 2)}/${sha}.${extension}`;
  if (!await storage.objectExists(objectKey)) {
    await storage.writeBinary(objectKey, { body: response.body, contentType, etag: sha });
  }

  const asset: MealImageAsset = {
    ...candidate,
    sha,
    objectKey,
    contentType,
    extension,
    byteLength: response.body.byteLength,
  };
  await storage.writeJson(mappingKey, { ...asset, archivedAt: response.fetchedAt } satisfies MediaMapping);
  return asset;
}

async function writeChangedArtifacts(
  source: SourceName,
  storage: CollectorStorage,
  options: CollectorOptions,
  response: JsonHttpResponse,
  sha: string,
  previousState: SourceState,
  timingContinuity: boolean,
): Promise<ChangedArtifacts> {
  if (source === "laundry") {
    const previous = previousState.lastNormalizedKey
      ? await storage.readJson<LaundryVersion>(previousState.lastNormalizedKey)
      : null;
    const normalized = normalizeLaundry(
      response.value,
      sha,
      response.fetchedAt,
      previous,
      {
        ...(options.lgRunStates ? { knownRunStates: options.lgRunStates } : {}),
        timingContinuity,
      },
    );
    const normalizedKey = `versions/laundry/${sha}/${occurrenceId(response.fetchedAt)}.json`;
    await storage.writeJson(normalizedKey, normalized);
    const firstOccurrenceKey = `versions/laundry/${sha}.json`;
    if (!await storage.objectExists(firstOccurrenceKey)) {
      await storage.writeJson(firstOccurrenceKey, normalized);
    }
    await storage.writeJson("latest/laundry.json", normalized);
    return { normalizedKey, laundryEvents: normalized.events };
  }

  if (source === "meals-include-pinned") {
    const normalized = await normalizeMeals(
      response.value,
      sha,
      response.fetchedAt,
      (candidate) => archiveMealImage(storage, options, candidate),
    );
    const normalizedKey = `versions/meals/${sha}/${occurrenceId(response.fetchedAt)}.json`;
    await storage.writeJson(normalizedKey, normalized);
    await storage.writeJson("latest/meals.json", normalized);
    return {
      normalizedKey,
      mealPosts: [...normalized.pinnedMenus, ...normalized.dailyMenus, ...normalized.otherPosts],
      mealObservedAt: normalized.observedAt,
    };
  }

  return { normalizedKey: null };
}

async function collectSource(
  source: SourceName,
  url: string,
  storage: CollectorStorage,
  options: CollectorOptions,
  scheduledAt: Date,
): Promise<CollectAllResult["results"][number]> {
  const previousState = await storage.readState(source) ?? emptyState(source);
  const attemptedAt = new Date().toISOString();

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": options.userAgent,
    };
    if (source !== "laundry") headers.Referer = options.urls.mealsPage;
    const response = await fetchJson(url, {
      timeoutMs: options.requestTimeoutMs,
      retries: options.requestRetries,
      headers,
    });
    const sha = await canonicalJsonSha256(response.value);
    const changed = sha !== previousState.lastResponseSha;

    if (!changed) {
      const state: SourceState = {
        ...previousState,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: response.fetchedAt,
        consecutiveFailures: 0,
        lastError: null,
      };
      await storage.commit({
        state,
        observation: minuteObservation(source, scheduledAt, response, state, false),
      });
      logger.debug("Source response unchanged", { source, sha, scheduledAt: scheduledAt.toISOString() });
      return { source, status: "SUCCESS", changed: false, sha, error: null };
    }

    const rawKey = snapshotPath(source, scheduledAt, sha);
    await storage.writeRaw(rawKey, response.raw);
    await storage.writeRaw(`latest/raw/${source}.json`, response.raw);
    const artifacts = await writeChangedArtifacts(
      source,
      storage,
      options,
      response,
      sha,
      previousState,
      hasTimingContinuity(previousState, response.fetchedAt),
    );
    const state: SourceState = {
      source,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: response.fetchedAt,
      lastResponseSha: sha,
      lastRawKey: rawKey,
      lastNormalizedKey: artifacts.normalizedKey,
      versionFirstSeenAt: response.fetchedAt,
      consecutiveFailures: 0,
      lastError: null,
    };
    await storage.commit({
      state,
      observation: minuteObservation(source, scheduledAt, response, state, true),
      ...(artifacts.laundryEvents ? { laundryEvents: artifacts.laundryEvents } : {}),
      ...(artifacts.mealPosts ? {
        mealPosts: artifacts.mealPosts,
        mealObservedAt: artifacts.mealObservedAt,
      } : {}),
    });
    logger.info("Stored new source version", { source, sha, rawKey, normalizedKey: artifacts.normalizedKey });
    return { source, status: "SUCCESS", changed: true, sha, error: null };
  } catch (error) {
    const diagnosticCode = diagnosticCodeOf(error);
    const failedAt = new Date().toISOString();
    const state: SourceState = {
      ...previousState,
      source,
      lastAttemptAt: attemptedAt,
      consecutiveFailures: previousState.consecutiveFailures + 1,
      lastError: PUBLIC_COLLECTION_FAILURE,
    };
    const observation: MinuteObservation = {
      source,
      minuteEpoch: minuteEpoch(scheduledAt),
      scheduledAt: scheduledAt.toISOString(),
      collectedAt: failedAt,
      status: "FAILED",
      versionSha: previousState.lastResponseSha,
      rawKey: previousState.lastRawKey,
      normalizedKey: previousState.lastNormalizedKey,
      versionFirstSeenAt: previousState.versionFirstSeenAt,
      changed: false,
      durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(attemptedAt)),
      httpStatus: null,
      error: PUBLIC_COLLECTION_FAILURE,
    };
    await storage.commit({ state, observation });
    logger.error("Source collection failed", {
      source, error: diagnosticCode, scheduledAt: scheduledAt.toISOString(),
    });
    return { source, status: "FAILED", changed: false, sha: null, error: PUBLIC_COLLECTION_FAILURE };
  }
}

export async function collectSources(
  storage: CollectorStorage,
  options: CollectorOptions,
  sources: readonly SourceName[],
  scheduledFor: Date = new Date(),
): Promise<CollectAllResult> {
  const scheduledAt = floorToMinute(scheduledFor);
  const results: CollectAllResult["results"] = [];
  const requested = new Set(sources);

  // Keep the upstream requests sequential. The laundry source is slow and the
  // Kakao variants must remain independently observable.
  if (requested.has("laundry")) {
    results.push(await collectSource("laundry", options.urls.laundry, storage, options, scheduledAt));
  }
  if (requested.has("meals-include-pinned")) {
    results.push(await collectSource(
      "meals-include-pinned",
      options.urls.mealsIncludePinned,
      storage,
      options,
      scheduledAt,
    ));
  }
  if (requested.has("meals-default")) {
    results.push(await collectSource("meals-default", options.urls.mealsDefault, storage, options, scheduledAt));
  }

  return { scheduledAt: scheduledAt.toISOString(), results };
}

export function collectAll(
  storage: CollectorStorage,
  options: CollectorOptions,
  scheduledFor: Date = new Date(),
): Promise<CollectAllResult> {
  return collectSources(storage, options, SOURCE_NAMES, scheduledFor);
}
