import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { chromium, type Response } from 'playwright';

import type { CapturedExchange, CollectedBundle, CollectionResult, ObserverConfig } from './types.ts';
import { BROWSER_DATA_DIR, debug, ensureDir, log, sha256 } from './utils.ts';

interface CollectOptions {
  entryUrl?: string | null;
  routes?: string[];
  artifactDir?: string | null;
}

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export async function loginAndPersistSession(config: ObserverConfig, entryUrl?: string | null): Promise<void> {
  await ensureDir(BROWSER_DATA_DIR);
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, launchOptions(false));
  const page = context.pages()[0] ?? await context.newPage();
  const url = absoluteUrl(entryUrl ?? config.entryPath, config.baseUrl);

  log('LOGIN', '브라우저에서 로그인한 뒤 브라우저 창을 닫으세요. 세션은 로컬에만 저장됩니다.');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForEvent('close', { timeout: 0 });
  log('LOGIN', '세션 저장 완료');
}

export async function collectCurrentRun(config: ObserverConfig, options: CollectOptions = {}): Promise<CollectionResult> {
  await ensureDir(BROWSER_DATA_DIR);
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, launchOptions(true));
  const page = context.pages()[0] ?? await context.newPage();
  const bundles = new Map<string, CollectedBundle>();
  const exchanges: CapturedExchange[] = [];
  const pending = new Set<Promise<void>>();
  const visitedRoutes: string[] = [];
  const targetOrigin = new URL(config.baseUrl).origin;

  const track = (response: Response): void => {
    const task = captureResponse(response, targetOrigin, config, bundles, exchanges)
      .catch((error: unknown) => debug('COLLECT', `응답 처리 실패: ${response.url()} — ${errorMessage(error)}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  context.on('response', track);

  try {
    const requestedRoutes = unique([
      options.entryUrl ?? config.entryPath,
      ...config.routes,
      ...(options.routes ?? []),
    ]);

    for (const route of requestedRoutes) {
      const url = absoluteUrl(route, config.baseUrl);
      if (new URL(url).origin !== targetOrigin) throw new Error(`대상 도메인 밖의 경로는 방문할 수 없습니다: ${url}`);
      log('COLLECT', `페이지 로드: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      assertSessionIsActive(page.url());
      visitedRoutes.push(new URL(page.url()).pathname);
    }

    await waitForPending(pending);
    const missingDependencies = directGetDependenciesNotObserved(config, exchanges);
    if (missingDependencies.length > 0) {
      log('COLLECT', `앱 의존 GET API 추가 관찰: ${missingDependencies.join(', ')}`);
      const results = await page.evaluate(async (paths) => Promise.all(paths.map(async (path) => {
        try {
          const response = await fetch(path, { credentials: 'include' });
          await response.arrayBuffer();
          return { path, ok: true };
        } catch {
          return { path, ok: false };
        }
      })), missingDependencies);
      for (const result of results) {
        if (!result.ok) debug('COLLECT', `앱 의존 API 요청 실패: ${result.path}`);
      }
      await waitForPending(pending);
    }
  } finally {
    context.off('response', track);
    await context.close();
  }

  const result: CollectionResult = {
    visitedRoutes: unique(visitedRoutes).sort(),
    bundles: [...bundles.values()].sort((left, right) => left.url.localeCompare(right.url)),
    exchanges: exchanges.sort((left, right) => `${left.method} ${left.url} ${left.status}`.localeCompare(`${right.method} ${right.url} ${right.status}`)),
  };

  if (options.artifactDir) await saveBundleArtifacts(result.bundles, options.artifactDir);
  log('COLLECT', `현재 실행: 번들 ${result.bundles.length}개, API 응답 ${result.exchanges.length}개`);
  return result;
}

async function captureResponse(
  response: Response,
  targetOrigin: string,
  config: ObserverConfig,
  bundles: Map<string, CollectedBundle>,
  exchanges: CapturedExchange[],
): Promise<void> {
  const url = new URL(response.url());
  if (url.origin !== targetOrigin) return;

  if (isNextBundle(url)) {
    const body = await readBoundedBody(response);
    if (!body) return;
    const hash = sha256(body);
    const key = `${url.href}#${hash}`;
    if (!bundles.has(key)) {
      const originalName = basename(url.pathname);
      const duplicateName = [...bundles.values()].some((bundle) => bundle.name === originalName);
      bundles.set(key, {
        name: duplicateName ? `${originalName.slice(0, -extname(originalName).length)}.${hash.slice(0, 8)}.js` : originalName,
        url: url.href,
        sha256: hash,
        code: body.toString('utf8'),
      });
      debug('COLLECT', `번들: ${originalName} (${Math.round(body.length / 1024)} KiB)`);
    }
  }

  if (!config.apiPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return;
  const request = response.request();
  const responseBody = await readApiBody(response);
  const requestContentType = normalizeContentType(request.headers()['content-type']);
  const responseContentType = normalizeContentType(response.headers()['content-type']);
  exchanges.push({
    method: request.method().toUpperCase(),
    url: url.href,
    status: response.status(),
    requestContentType,
    requestBody: parseBody(request.postData(), requestContentType),
    responseContentType,
    responseBody: parseBody(responseBody, responseContentType),
  });
  debug('COLLECT', `API: ${request.method()} ${url.pathname} → ${response.status()}`);
}

async function readBoundedBody(response: Response): Promise<Buffer | null> {
  const declaredLength = Number(response.headers()['content-length'] ?? 0);
  if (declaredLength > MAX_CAPTURE_BYTES) {
    debug('COLLECT', `응답 크기 제한 초과로 제외: ${response.url()} (${declaredLength} bytes)`);
    return null;
  }
  const body = await response.body();
  if (body.length > MAX_CAPTURE_BYTES) {
    debug('COLLECT', `응답 크기 제한 초과로 제외: ${response.url()} (${body.length} bytes)`);
    return null;
  }
  return body;
}

async function readApiBody(response: Response): Promise<string | undefined> {
  if ([204, 205, 304].includes(response.status())) return undefined;
  const body = await readBoundedBody(response);
  if (!body || body.length === 0) return undefined;
  const contentType = normalizeContentType(response.headers()['content-type']);
  if (contentType && !isTextContentType(contentType)) return undefined;
  return body.toString('utf8');
}

function parseBody(value: string | null | undefined, contentType: string | null): unknown {
  if (value === null || value === undefined || value.length === 0) return undefined;
  if (contentType?.includes('json') || /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeContentType(value: string | undefined): string | null {
  return value?.split(';')[0]?.trim().toLowerCase() || null;
}

function isTextContentType(value: string): boolean {
  return value.startsWith('text/') || value.includes('json') || value.includes('xml') || value.includes('javascript') || value.includes('form-urlencoded');
}

function isNextBundle(url: URL): boolean {
  return url.pathname.includes('/_next/static/chunks/') && url.pathname.endsWith('.js');
}

function assertSessionIsActive(url: string): void {
  if (url.includes('/login') || url.includes('accounts.google.com')) {
    throw new Error('로그인 세션이 만료되었습니다. `npm run login`으로 다시 로그인하세요.');
  }
}

function directGetDependenciesNotObserved(config: ObserverConfig, exchanges: CapturedExchange[]): string[] {
  const observed = new Set(exchanges
    .filter((exchange) => exchange.method === 'GET')
    .map((exchange) => new URL(exchange.url).pathname));
  return Object.keys(config.appDependencies)
    .filter((signature) => signature.startsWith('GET '))
    .map((signature) => signature.slice(4))
    .filter((path) => !path.includes('{') && !observed.has(path))
    .sort();
}

async function waitForPending(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function saveBundleArtifacts(bundles: CollectedBundle[], directory: string): Promise<void> {
  await ensureDir(directory);
  await Promise.all(bundles.map((bundle) => writeFile(join(directory, bundle.name), bundle.code, 'utf8')));
  log('COLLECT', `진단용 현재 번들 저장: ${directory}`);
}

function launchOptions(headless: boolean): Parameters<typeof chromium.launchPersistentContext>[1] {
  return {
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).href;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
