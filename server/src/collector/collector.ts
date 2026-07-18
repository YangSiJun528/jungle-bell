import { getLogger } from "@logtape/logtape";
import { canonicalJsonSha256, sha256Bytes } from "./hash";
import { fetchBinary, fetchJson } from "./http";
import { normalizeLaundry, type LaundryVersion } from "./laundry";
import { normalizeMeals, type MealImageAsset, type MealImageCandidate, type MealPost } from "./meals";
import {
  datedObjectPath,
  floorToMinute,
  latestCollectionCommitPath,
  minuteEpoch,
  snapshotPath,
} from "./time";
import type {
  CollectAllResult,
  CollectionCommit,
  CollectorOptions,
  JsonHttpResponse,
  MinuteObservation,
  SourceName,
  SourceState,
} from "./types";

const logger = getLogger(["jungle-bell", "collector"]);

interface MediaMapping extends MealImageAsset {
  archivedAt: string;
}

interface ChangedArtifacts {
  normalizedKey: string | null;
  laundryEvents?: CollectionCommit["laundryEvents"];
  mealPosts?: MealPost[];
  mealObservedAt?: string;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

async function writeJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function writeRaw(bucket: R2Bucket, key: string, raw: string): Promise<void> {
  await bucket.put(key, raw, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function archiveCommit(bucket: R2Bucket, commit: CollectionCommit): Promise<void> {
  const { observation, state } = commit;
  const key = datedObjectPath(
    `collector/commits/${observation.source}`,
    new Date(observation.scheduledAt),
    `${observation.minuteEpoch}.json`,
  );
  await writeJson(bucket, key, commit);
  await writeJson(bucket, latestCollectionCommitPath(observation.source), commit);
  await writeJson(bucket, `collector/state/${state.source}.json`, state);
}

function occurrenceId(observedAt: string): string {
  return observedAt.replaceAll(/[-:.]/g, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function extensionFor(contentType: string, filename: string | null): string {
  const byContentType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const mapped = byContentType[contentType.toLowerCase()];
  if (mapped) return mapped;
  const filenameExtension = filename?.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase();
  return filenameExtension ?? "bin";
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
  bucket: R2Bucket,
  options: CollectorOptions,
  candidate: MealImageCandidate,
): Promise<MealImageAsset> {
  const mappingKey = `media-map/${candidate.postId}/${candidate.mediaId}.json`;
  const existing = await readJson<MediaMapping>(bucket, mappingKey);
  if (existing?.sourceUrl === candidate.sourceUrl && await bucket.head(existing.objectKey)) {
    const { archivedAt: _archivedAt, ...asset } = existing;
    return asset;
  }

  const response = await fetchBinary(candidate.sourceUrl, {
    timeoutMs: options.requestTimeoutMs,
    retries: options.requestRetries,
    headers: { "User-Agent": options.userAgent },
  });
  const contentType = response.contentType === "application/octet-stream"
    ? candidate.declaredContentType ?? response.contentType
    : response.contentType;
  if (!contentType.startsWith("image/")) {
    throw new Error(`Media ${candidate.mediaId} returned ${contentType}, not an image`);
  }
  const sha = await sha256Bytes(response.body);
  const extension = extensionFor(contentType, candidate.filename);
  const objectKey = `assets/${sha.slice(0, 2)}/${sha}.${extension}`;
  if (!await bucket.head(objectKey)) {
    await bucket.put(objectKey, response.body, {
      httpMetadata: { contentType },
      customMetadata: { sha256: sha },
    });
  }

  const asset: MealImageAsset = {
    ...candidate,
    sha,
    objectKey,
    contentType,
    extension,
    byteLength: response.body.byteLength,
  };
  await writeJson(bucket, mappingKey, { ...asset, archivedAt: response.fetchedAt } satisfies MediaMapping);
  return asset;
}

async function writeChangedArtifacts(
  source: SourceName,
  bucket: R2Bucket,
  options: CollectorOptions,
  response: JsonHttpResponse,
  sha: string,
  previousState: SourceState,
): Promise<ChangedArtifacts> {
  if (source === "laundry") {
    const previous = previousState.lastNormalizedKey
      ? await readJson<LaundryVersion>(bucket, previousState.lastNormalizedKey)
      : null;
    const normalized = normalizeLaundry(
      response.value,
      sha,
      response.fetchedAt,
      previous,
      options.lgRunStates ? { knownRunStates: options.lgRunStates } : {},
    );
    const normalizedKey = `versions/laundry/${sha}/${occurrenceId(response.fetchedAt)}.json`;
    await writeJson(bucket, normalizedKey, normalized);
    const firstOccurrenceKey = `versions/laundry/${sha}.json`;
    if (!await bucket.head(firstOccurrenceKey)) {
      await writeJson(bucket, firstOccurrenceKey, normalized);
    }
    await writeJson(bucket, "latest/laundry.json", normalized);
    return { normalizedKey, laundryEvents: normalized.events };
  }

  if (source === "meals-include-pinned") {
    const normalized = await normalizeMeals(
      response.value,
      sha,
      response.fetchedAt,
      (candidate) => archiveMealImage(bucket, options, candidate),
    );
    const normalizedKey = `versions/meals/${sha}/${occurrenceId(response.fetchedAt)}.json`;
    await writeJson(bucket, normalizedKey, normalized);
    await writeJson(bucket, "latest/meals.json", normalized);
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
  bucket: R2Bucket,
  options: CollectorOptions,
  scheduledAt: Date,
): Promise<CollectAllResult["results"][number]> {
  const previousState = await readJson<SourceState>(bucket, `collector/state/${source}.json`) ?? emptyState(source);
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
      await archiveCommit(bucket, {
        state,
        observation: minuteObservation(source, scheduledAt, response, state, false),
      });
      logger.debug("Source response unchanged", { source, sha, scheduledAt: scheduledAt.toISOString() });
      return { source, status: "SUCCESS", changed: false, sha, error: null };
    }

    const rawKey = snapshotPath(source, scheduledAt, sha);
    await writeRaw(bucket, rawKey, response.raw);
    await writeRaw(bucket, `latest/raw/${source}.json`, response.raw);
    const artifacts = await writeChangedArtifacts(source, bucket, options, response, sha, previousState);
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
    await archiveCommit(bucket, {
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
    const errorMessage = messageOf(error);
    const failedAt = new Date().toISOString();
    const state: SourceState = {
      ...previousState,
      source,
      lastAttemptAt: attemptedAt,
      consecutiveFailures: previousState.consecutiveFailures + 1,
      lastError: errorMessage,
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
      error: errorMessage,
    };
    await archiveCommit(bucket, { state, observation });
    logger.error("Source collection failed", { source, error: errorMessage, scheduledAt: scheduledAt.toISOString() });
    return { source, status: "FAILED", changed: false, sha: null, error: errorMessage };
  }
}

export async function collectAll(
  bucket: R2Bucket,
  options: CollectorOptions,
  scheduledFor: Date = new Date(),
): Promise<CollectAllResult> {
  const scheduledAt = floorToMinute(scheduledFor);
  const results: CollectAllResult["results"] = [];

  // Keep the upstream requests sequential. The laundry source is slow and the
  // Kakao variants must remain independently observable.
  results.push(await collectSource("laundry", options.urls.laundry, bucket, options, scheduledAt));
  results.push(await collectSource(
    "meals-include-pinned",
    options.urls.mealsIncludePinned,
    bucket,
    options,
    scheduledAt,
  ));
  results.push(await collectSource("meals-default", options.urls.mealsDefault, bucket, options, scheduledAt));

  return { scheduledAt: scheduledAt.toISOString(), results };
}
