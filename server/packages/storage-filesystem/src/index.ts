import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, utimes } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type {
  BinaryObject,
  CollectionCommit,
  CollectorStorage,
  SourceName,
  SourceState,
} from "../../collector-core/src/types";

function datePath(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  const [day] = date.toISOString().split("T");
  return day?.replaceAll("-", "/") ?? "invalid-date";
}

function compactTime(value: string): string {
  return new Date(value).toISOString().replaceAll(/[-:.]/g, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class FileSystemStorage implements CollectorStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return path;
  }

  private async atomicWrite(key: string, data: string | Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, data, { fsync: true });
  }

  async readState(source: SourceName): Promise<SourceState | null> {
    return this.readJson<SourceState>(`state/sources/${source}.json`);
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.atomicWrite(key, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeRaw(key: string, raw: string): Promise<void> {
    await this.atomicWrite(key, raw.endsWith("\n") ? raw : `${raw}\n`);
  }

  async objectExists(key: string): Promise<boolean> {
    const path = this.path(key);
    if (!await exists(path)) return false;
    if (key.startsWith("assets/")) {
      const metadata = await stat(path);
      const now = new Date();
      await utimes(path, metadata.atime, now);
      const metadataPath = `${path}.metadata.json`;
      if (await exists(metadataPath)) {
        const binaryMetadata = await stat(metadataPath);
        await utimes(metadataPath, binaryMetadata.atime, now);
      }
    }
    return true;
  }

  async writeBinary(key: string, object: BinaryObject): Promise<void> {
    await this.atomicWrite(key, Buffer.from(object.body));
    await this.writeJson(`${key}.metadata.json`, {
      contentType: object.contentType,
      etag: object.etag ?? null,
      byteLength: object.body.byteLength,
    });
  }

  async commit(commit: CollectionCommit): Promise<void> {
    const { observation, state, version, laundryEvents = [] } = commit;
    if (version) {
      const versionKey = `indexes/source-versions/${version.source}/${version.sha}.json`;
      if (!await exists(this.path(versionKey))) await this.writeJson(versionKey, version);
    }

    for (const event of laundryEvents) {
      const digest = createHash("sha256").update(event.id).digest("hex");
      const key = `events/${datePath(event.observedAt)}/${compactTime(event.observedAt)}-${digest}.json`;
      if (!await exists(this.path(key))) await this.writeJson(key, event);
    }

    const observationKey = [
      "observations",
      datePath(observation.scheduledAt),
      `${compactTime(observation.scheduledAt)}-${observation.source}.json`,
    ].join("/");
    if (!await exists(this.path(observationKey))) await this.writeJson(observationKey, observation);

    await this.writeJson(`state/sources/${state.source}.json`, state);
  }
}
