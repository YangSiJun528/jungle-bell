import type { CollectionCommit, SourceName, SourceState } from "../collection/types";

export interface BinaryObject {
  body: Uint8Array;
  contentType: string;
  etag?: string;
}

export interface CollectorStorage {
  readState(source: SourceName): Promise<SourceState | null>;
  readJson<T>(key: string): Promise<T | null>;
  writeJson(key: string, value: unknown): Promise<void>;
  writeRaw(key: string, raw: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  writeBinary(key: string, object: BinaryObject): Promise<void>;
  commit(commit: CollectionCommit): Promise<void>;
}
