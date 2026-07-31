import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

export const DEFAULT_BACKUP_RETENTION_DAYS = 30;
export const MIN_BACKUP_RETENTION_DAYS = 1;
export const MAX_BACKUP_RETENTION_DAYS = 3_650;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const BACKUP_FILE_PATTERN =
  /^jungle-bell-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite$/u;

function assertRetentionDays(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_BACKUP_RETENTION_DAYS ||
    value > MAX_BACKUP_RETENTION_DAYS
  ) {
    throw new Error("JB_BACKUP_RETENTION_DAYS_INVALID");
  }
  return value;
}

export function parseBackupRetentionDays(
  value: string | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_BACKUP_RETENTION_DAYS;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("JB_BACKUP_RETENTION_DAYS_INVALID");
  }
  return assertRetentionDays(Number(value));
}

function formatBackupTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("SQLITE_BACKUP_TIME_INVALID");
  }
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/u, "Z");
  if (!/^\d{8}T\d{6}Z$/u.test(timestamp)) {
    throw new Error("SQLITE_BACKUP_TIME_INVALID");
  }
  return timestamp;
}

function backupCreatedAtEpochMs(filename: string): number | undefined {
  const match = BACKUP_FILE_PATTERN.exec(filename);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const epochMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(epochMs)) {
    return undefined;
  }
  const parsed = new Date(epochMs);
  return formatBackupTimestamp(parsed) ===
    `${year}${month}${day}T${hour}${minute}${second}Z`
    ? epochMs
    : undefined;
}

async function ensureSafeBackupDirectory(
  backupDirectory: string,
): Promise<void> {
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(backupDirectory);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("SQLITE_BACKUP_DIRECTORY_UNSAFE");
  }
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function unlinkMatchingRegularFile(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  let candidate;
  try {
    candidate = await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (
    candidate.isSymbolicLink() ||
    !candidate.isFile() ||
    candidate.dev !== expected.dev ||
    candidate.ino !== expected.ino
  ) {
    return;
  }
  await unlink(path);
}

export async function pruneExpiredSqliteBackups(input: {
  readonly sourcePath: string;
  readonly backupDirectory: string;
  readonly retentionDays?: number;
  readonly now?: Date;
}): Promise<readonly string[]> {
  const sourcePath = resolve(input.sourcePath);
  const backupDirectory = resolve(input.backupDirectory);
  const retentionDays = assertRetentionDays(
    input.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
  );
  const now = input.now ?? new Date();
  const nowEpochMs = now.getTime();
  if (!Number.isFinite(nowEpochMs)) {
    throw new Error("SQLITE_BACKUP_TIME_INVALID");
  }

  await ensureSafeBackupDirectory(backupDirectory);
  const source = await stat(sourcePath);
  const cutoffEpochMs =
    nowEpochMs - retentionDays * MILLISECONDS_PER_DAY;
  const deleted: string[] = [];

  for (const entry of await readdir(backupDirectory, {
    withFileTypes: true,
  })) {
    const createdAtEpochMs = backupCreatedAtEpochMs(entry.name);
    if (
      createdAtEpochMs === undefined ||
      createdAtEpochMs >= cutoffEpochMs
    ) {
      continue;
    }

    const candidate = resolve(backupDirectory, entry.name);
    if (candidate === sourcePath) {
      continue;
    }
    const candidateStat = await lstat(candidate);
    if (
      candidateStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      candidateStat.nlink !== 1 ||
      (candidateStat.dev === source.dev &&
        candidateStat.ino === source.ino)
    ) {
      continue;
    }

    await unlink(candidate);
    deleted.push(candidate);
  }

  return deleted;
}

export async function backupSqliteDatabase(input: {
  readonly sourcePath: string;
  readonly backupDirectory: string;
  readonly retentionDays?: number;
  readonly now?: Date;
}): Promise<string> {
  const sourcePath = resolve(input.sourcePath);
  const backupDirectory = resolve(input.backupDirectory);
  const retentionDays = assertRetentionDays(
    input.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
  );
  if (sourcePath === backupDirectory) {
    throw new Error("SQLITE_BACKUP_PATH_INVALID");
  }
  await ensureSafeBackupDirectory(backupDirectory);
  const now = input.now ?? new Date();
  const timestamp = formatBackupTimestamp(now);
  const destination = resolve(
    backupDirectory,
    `jungle-bell-${timestamp}.sqlite`,
  );

  const stagingDirectory = await mkdtemp(
    resolve(backupDirectory, ".jungle-bell-backup-"),
  );
  await chmod(stagingDirectory, 0o700);
  const stagingDestination = resolve(
    stagingDirectory,
    "snapshot.sqlite",
  );
  let publishedIdentity: FileIdentity | undefined;
  let destinationPublished = false;
  try {
    const source = new Database(sourcePath, {
      fileMustExist: true,
      readonly: true,
    });
    try {
      const stagingClaim = await open(
        stagingDestination,
        "wx",
        0o600,
      );
      await stagingClaim.close();
      await source.backup(stagingDestination);
    } finally {
      source.close();
    }
    await chmod(stagingDestination, 0o600);

    const snapshot = new Database(stagingDestination, {
      fileMustExist: true,
    });
    try {
      const journalMode = snapshot.pragma("journal_mode = DELETE", {
        simple: true,
      });
      if (journalMode !== "delete") {
        throw new Error("SQLITE_BACKUP_JOURNAL_MODE_FAILED");
      }
      const result = snapshot.pragma("integrity_check", {
        simple: true,
      });
      if (result !== "ok") {
        throw new Error("SQLITE_BACKUP_INTEGRITY_FAILED");
      }
      const foreignKeyViolations = snapshot.pragma("foreign_key_check");
      if (
        !Array.isArray(foreignKeyViolations) ||
        foreignKeyViolations.length !== 0
      ) {
        throw new Error("SQLITE_BACKUP_FOREIGN_KEY_FAILED");
      }
    } finally {
      snapshot.close();
    }

    const staged = await lstat(stagingDestination);
    const sourceStat = await stat(sourcePath);
    if (
      staged.isSymbolicLink() ||
      !staged.isFile() ||
      staged.nlink !== 1 ||
      (staged.dev === sourceStat.dev &&
        staged.ino === sourceStat.ino)
    ) {
      throw new Error("SQLITE_BACKUP_STAGING_UNSAFE");
    }
    publishedIdentity = {
      dev: staged.dev,
      ino: staged.ino,
    };

    try {
      await link(stagingDestination, destination);
      destinationPublished = true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error("SQLITE_BACKUP_DESTINATION_EXISTS");
      }
      throw error;
    }

    const published = await lstat(destination);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.dev !== publishedIdentity.dev ||
      published.ino !== publishedIdentity.ino
    ) {
      throw new Error("SQLITE_BACKUP_PUBLICATION_UNSAFE");
    }
  } catch (error) {
    if (destinationPublished && publishedIdentity) {
      await unlinkMatchingRegularFile(
        destination,
        publishedIdentity,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }

  if (!publishedIdentity) {
    throw new Error("SQLITE_BACKUP_PUBLICATION_FAILED");
  }
  const published = await lstat(destination);
  if (
    published.isSymbolicLink() ||
    !published.isFile() ||
    published.nlink !== 1 ||
    published.dev !== publishedIdentity.dev ||
    published.ino !== publishedIdentity.ino
  ) {
    await unlinkMatchingRegularFile(
      destination,
      publishedIdentity,
    ).catch(() => undefined);
    throw new Error("SQLITE_BACKUP_PUBLICATION_UNSAFE");
  }

  await pruneExpiredSqliteBackups({
    sourcePath,
    backupDirectory,
    retentionDays,
    now,
  });
  return destination;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const destination = await backupSqliteDatabase({
    sourcePath:
      process.env.JB_DB_PATH ?? ".data/jungle-bell.sqlite",
    backupDirectory:
      process.env.JB_BACKUP_DIRECTORY ?? ".backups",
    retentionDays: parseBackupRetentionDays(
      process.env.JB_BACKUP_RETENTION_DAYS,
    ),
  });
  process.stdout.write(`${destination}\n`);
}
