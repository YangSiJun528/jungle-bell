import { createHash } from "node:crypto";

import type {
  CampusKind,
  CampusSnapshotData,
  MealHistoryPage,
  PublicCampusSnapshot,
} from "./contracts.js";
import {
  detectLaundryTransitionEvents,
  detectMealPublishedEvents,
  type CampusEventSink,
} from "./events.js";
import type { CampusRepository } from "./repository.js";
import {
  CampusSourceError,
  type CampusDataSource,
} from "./source.js";

const DEFAULT_MAX_AGE_MS = {
  laundry: 2 * 60_000,
  meals: 15 * 60_000,
} as const satisfies Record<CampusKind, number>;

const DEFAULT_POLL_INTERVAL_MS = {
  laundry: 30_000,
  meals: 5 * 60_000,
} as const satisfies Record<CampusKind, number>;

export interface CampusCollectorLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export class CampusCollectorService {
  private readonly active = new Map<
    CampusKind,
    Promise<PublicCampusSnapshot>
  >();
  private readonly now: () => number;
  private readonly maxAgeMs: Readonly<Record<CampusKind, number>>;
  private readonly pollIntervalMs: Readonly<Record<CampusKind, number>>;

  constructor(
    private readonly dependencies: {
      readonly source: CampusDataSource;
      readonly repository: CampusRepository;
      readonly now?: () => number;
      readonly maxAgeMs?: Partial<Record<CampusKind, number>>;
      readonly pollIntervalMs?: Partial<Record<CampusKind, number>>;
      readonly eventSink?: CampusEventSink;
      readonly logger?: CampusCollectorLogger;
    },
  ) {
    this.now = dependencies.now ?? Date.now;
    this.maxAgeMs = {
      ...DEFAULT_MAX_AGE_MS,
      ...dependencies.maxAgeMs,
    };
    this.pollIntervalMs = {
      ...DEFAULT_POLL_INTERVAL_MS,
      ...dependencies.pollIntervalMs,
    };
    for (const value of [
      ...Object.values(this.maxAgeMs),
      ...Object.values(this.pollIntervalMs),
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError("Campus timing values must be positive integers.");
      }
    }
  }

  getLatest<K extends CampusKind>(
    kind: K,
  ): PublicCampusSnapshot<K> {
    return this.dependencies.repository.readPublicSnapshot(
      kind,
      this.now(),
      this.maxAgeMs[kind],
    );
  }

  async refresh<K extends CampusKind>(
    kind: K,
  ): Promise<PublicCampusSnapshot<K>> {
    const running = this.active.get(kind);
    if (running !== undefined) {
      return running as Promise<PublicCampusSnapshot<K>>;
    }
    const refresh = this.refreshOnce(kind).finally(() => {
      if (this.active.get(kind) === refresh) {
        this.active.delete(kind);
      }
    });
    this.active.set(kind, refresh);
    return refresh;
  }

  async refreshDue(): Promise<PublicCampusSnapshot[]> {
    const nowEpochMs = this.now();
    const kinds =
      this.dependencies.repository.listDueKinds(nowEpochMs);
    return Promise.all(kinds.map((kind) => this.refresh(kind)));
  }

  async getMealHistory(input?: {
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MealHistoryPage> {
    return this.dependencies.source.fetchMealHistory(input);
  }

  private async refreshOnce<K extends CampusKind>(
    kind: K,
  ): Promise<PublicCampusSnapshot<K>> {
    const state = this.dependencies.repository.getSourceState(kind);
    try {
      const response = await this.dependencies.source.fetch(kind, {
        ...(state?.etag ? { ifNoneMatch: state.etag } : {}),
      });
      const nextPollAtEpochMs =
        response.checkedAtEpochMs + this.pollIntervalMs[kind];
      if (response.status === "not-modified") {
        this.dependencies.repository.recordNotModified({
          kind,
          etag: response.etag,
          checkedAtEpochMs: response.checkedAtEpochMs,
          nextPollAtEpochMs,
        });
      } else {
        this.recordDetectedEvents(
          kind,
          this.dependencies.repository.getStoredSnapshot(kind)?.data ??
            null,
          response.data,
          response.checkedAtEpochMs,
        );
        this.dependencies.repository.saveSuccess({
          kind,
          etag: response.etag,
          contentSha256: sha256(response.data),
          data: response.data,
          checkedAtEpochMs: response.checkedAtEpochMs,
          nextPollAtEpochMs,
        });
      }
    } catch (error) {
      const checkedAtEpochMs = this.now();
      const previousFailures = state?.consecutiveFailures ?? 0;
      const retryMs = failureBackoffMs(
        this.pollIntervalMs[kind],
        previousFailures + 1,
      );
      const normalized = normalizeError(error);
      this.dependencies.repository.recordFailure({
        kind,
        checkedAtEpochMs,
        nextPollAtEpochMs: checkedAtEpochMs + retryMs,
        errorCode: normalized.code,
        errorMessage: normalized.message,
      });
      this.dependencies.logger?.warn("campus collection failed", {
        kind,
        code: normalized.code,
      });
    }
    return this.getLatest(kind);
  }

  private recordDetectedEvents<K extends CampusKind>(
    kind: K,
    previous: CampusSnapshotData<K> | null,
    current: CampusSnapshotData<K>,
    nowEpochMs: number,
  ): void {
    const sink = this.dependencies.eventSink;
    if (sink === undefined) return;
    const events =
      kind === "laundry"
        ? detectLaundryTransitionEvents(
            previous as CampusSnapshotData<"laundry"> | null,
            current as CampusSnapshotData<"laundry">,
            nowEpochMs,
          )
        : detectMealPublishedEvents(
            previous as CampusSnapshotData<"meals"> | null,
            current as CampusSnapshotData<"meals">,
            nowEpochMs,
          );
    for (const event of events) sink.record(event);
  }
}

export function failureBackoffMs(
  baseIntervalMs: number,
  consecutiveFailures: number,
): number {
  if (
    !Number.isSafeInteger(baseIntervalMs) ||
    baseIntervalMs <= 0 ||
    !Number.isSafeInteger(consecutiveFailures) ||
    consecutiveFailures < 1
  ) {
    throw new TypeError("Invalid campus retry inputs.");
  }
  return Math.min(
    30 * 60_000,
    baseIntervalMs * 2 ** Math.min(6, consecutiveFailures - 1),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizeError(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof CampusSourceError) {
    return {
      code: error.code,
      message: error.message.slice(0, 1_024),
    };
  }
  if (
    error instanceof Error &&
    error.message === "CAMPUS_NOT_MODIFIED_WITHOUT_SNAPSHOT"
  ) {
    return {
      code: "INVALID_NOT_MODIFIED",
      message: "Campus source returned 304 before any snapshot was stored.",
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected campus collection error.",
  };
}
