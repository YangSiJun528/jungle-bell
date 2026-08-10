import { createHash } from 'node:crypto';
import { globSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CollectedBundle, ObserverReport } from './types.ts';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = join(PROJECT_ROOT, 'output');
export const BROWSER_DATA_DIR = join(PROJECT_ROOT, '.browser-data');
export const REPORT_PATH = join(OUTPUT_DIR, 'report.json');
export const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, 'observer.config.json');

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function log(stage: string, message: string): void {
  console.log(`[${stage}] ${message}`);
}

export function debug(stage: string, message: string): void {
  if (verbose) console.log(`[${stage}][DEBUG] ${message}`);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function readObserverReport(path: string): Promise<ObserverReport | null> {
  const value = await readJson<unknown>(path);
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1) return null;
  return value as ObserverReport;
}

export async function loadBundlesFromDirectory(directory: string): Promise<CollectedBundle[]> {
  const files = globSync(join(directory, '**/*.js')).sort();
  const bundles = await Promise.all(files.map(async (path) => {
    const code = await readFile(path, 'utf8');
    return {
      name: relative(directory, path),
      url: pathToFileURL(path).href,
      sha256: sha256(code),
      code,
    };
  }));
  return bundles;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function timestampedFilename(now = new Date()): string {
  return `${now.toISOString().replaceAll(':', '-')}.json`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
