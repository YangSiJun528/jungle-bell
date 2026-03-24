import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertType } from './assert.mjs';

// ── 경로 상수 ──────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

export const OUTPUT_DIR = join(PROJECT_ROOT, 'output');
export const BROWSER_DATA_DIR = join(PROJECT_ROOT, '.browser-data');
export const RAW_BUNDLES_DIR = join(OUTPUT_DIR, 'raw-bundles');
export const DEBUNDLED_DIR = join(OUTPUT_DIR, 'debundled');
export const UNMINIFIED_DIR = join(OUTPUT_DIR, 'unminified');
export const API_MODULES_DIR = join(OUTPUT_DIR, 'api-modules');
export const API_REQUESTS_PATH = join(OUTPUT_DIR, 'api-requests.json');
export const REPORT_PATH = join(API_MODULES_DIR, 'report.json');

// ── verbose 제어 ───────────────────────────────
let verbose = false;
export function setVerbose(v) { verbose = v; }

// ── 로깅 ───────────────────────────────────────
export function log(stage, message) {
  console.log(`[${stage}] ${message}`);
}

export function debug(stage, message) {
  if (verbose) console.log(`[${stage}][DEBUG] ${message}`);
}

// ── 파일 유틸 ──────────────────────────────────
export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  assert(existsSync(dirPath), 'UTILS', `디렉토리 생성 실패: ${dirPath}`);
}

export async function writeJson(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2));
  assert(existsSync(filePath), 'UTILS', `JSON 파일 쓰기 실패: ${filePath}`);
}

export async function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  const data = JSON.parse(await readFile(filePath, 'utf-8'));
  assertType(data, 'object', 'UTILS', `readJson(${filePath})`);
  return data;
}
