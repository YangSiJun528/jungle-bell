import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let verbose = false;
export function setVerbose(v) { verbose = v; }

export function log(stage, msg) { console.log(`[${stage}] ${msg}`); }
export function debug(stage, msg) { if (verbose) console.log(`[${stage}][DEBUG] ${msg}`); }

export async function ensureDir(p) { await mkdir(p, { recursive: true }); }
export async function writeJson(p, data) { await writeFile(p, JSON.stringify(data, null, 2)); }
