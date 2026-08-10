import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiffResult, ObserverReport } from './types.ts';
import { ensureDir, timestampedFilename, writeJson } from './utils.ts';

export async function loadLatestSnapshot(logsDirectory: string): Promise<ObserverReport | null> {
  let files: string[];
  try {
    files = (await readdir(logsDirectory)).filter((file) => file.endsWith('.json')).sort().reverse();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!files[0]) return null;
  const value = JSON.parse(await readFile(join(logsDirectory, files[0]), 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1) {
    throw new Error(`지원하지 않는 스냅샷 형식: ${join(logsDirectory, files[0])}`);
  }
  return value as ObserverReport;
}

export async function saveSnapshot(report: ObserverReport, logsDirectory: string): Promise<string> {
  await ensureDir(logsDirectory);
  const path = join(logsDirectory, timestampedFilename());
  await writeJson(path, report);
  return path;
}

export async function saveChanges(diff: DiffResult, changesDirectory: string): Promise<string> {
  await ensureDir(changesDirectory);
  const path = join(changesDirectory, timestampedFilename());
  await writeJson(path, {
    generatedAt: new Date().toISOString(),
    changeCount: diff.changes.length,
    changes: diff.changes,
  });
  return path;
}
