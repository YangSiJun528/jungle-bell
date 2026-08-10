import { readJson } from './utils.ts';
import type { ObserverConfig } from './types.ts';

export async function loadConfig(path: string): Promise<ObserverConfig> {
  const value = await readJson<unknown>(path);
  if (!value) throw new Error(`설정 파일을 찾을 수 없습니다: ${path}`);
  if (!isRecord(value)) throw new Error(`설정 파일의 최상위 값은 객체여야 합니다: ${path}`);

  const baseUrl = requiredString(value, 'baseUrl');
  const parsedBaseUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) throw new Error('baseUrl은 HTTP(S) URL이어야 합니다.');

  const entryPath = requiredPath(value, 'entryPath');
  const routes = stringArray(value.routes, 'routes').map((route) => validateRoute(route, 'routes'));
  const relativeApiBasePath = requiredPath(value, 'relativeApiBasePath').replace(/\/$/, '');
  const apiPathPrefixes = stringArray(value.apiPathPrefixes, 'apiPathPrefixes')
    .map((prefix) => validatePath(prefix, 'apiPathPrefixes'));
  if (apiPathPrefixes.length === 0) throw new Error('apiPathPrefixes에는 하나 이상의 경로가 필요합니다.');

  if (!isRecord(value.appDependencies)) throw new Error('appDependencies는 "METHOD /path": ["field"] 객체여야 합니다.');
  const appDependencies: Record<string, string[]> = {};
  for (const [signature, fields] of Object.entries(value.appDependencies)) {
    if (!/^(GET|POST|PATCH|PUT|DELETE) \/\S+$/.test(signature)) {
      throw new Error(`잘못된 appDependencies 엔드포인트: ${signature}`);
    }
    appDependencies[signature] = [...new Set(stringArray(fields, `appDependencies.${signature}`))].sort();
  }

  return {
    baseUrl: parsedBaseUrl.origin,
    entryPath,
    routes: [...new Set(routes)],
    relativeApiBasePath,
    apiPathPrefixes: [...new Set(apiPathPrefixes)],
    appDependencies,
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim().length === 0) throw new Error(`${key}에는 문자열이 필요합니다.`);
  return item.trim();
}

function requiredPath(value: Record<string, unknown>, key: string): string {
  return validatePath(requiredString(value, key), key);
}

function validatePath(value: string, key: string): string {
  if (!value.startsWith('/')) throw new Error(`${key} 경로는 /로 시작해야 합니다: ${value}`);
  return value;
}

function validateRoute(value: string, key: string): string {
  if (value.startsWith('/')) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return value;
  } catch {
    // Fall through to the contextual error below.
  }
  throw new Error(`${key}에는 절대 URL 또는 /로 시작하는 경로가 필요합니다: ${value}`);
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key}에는 문자열 배열이 필요합니다.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
