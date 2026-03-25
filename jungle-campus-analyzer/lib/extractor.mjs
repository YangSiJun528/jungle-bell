import { readFileSync, globSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir, writeJson, REPORT_PATH } from './utils.mjs';

const ENUM_KEY_RE = /^[A-Z][A-Z_]{1,}$/;

export async function extract(unminifiedDir, outputDir, options = {}) {
  let files = globSync(join(unminifiedDir, '**/*.js').replace(/\\/g, '/'));
  if (files.length === 0) {
    files = globSync(join(unminifiedDir.replace('unminified', 'debundled'), '**/*.js').replace(/\\/g, '/'));
  }
  assertNonEmpty(files, 'EXTRACT', 'unminified 모듈 파일');

  // httpV2 호출 포함 모듈만 로드
  const modules = [];
  for (const fp of files) {
    const code = readFileSync(fp, 'utf-8');
    if (code.includes('httpV2.')) modules.push({ path: fp, code });
  }
  log('EXTRACT', `${files.length}개 모듈 중 httpV2 포함 ${modules.length}개`);

  const apiCalls = extractApiCalls(modules);
  log('EXTRACT', `API 호출 ${apiCalls.length}개 추출`);

  const enums = extractEnums(modules);
  for (const [name, values] of Object.entries(enums)) {
    log('EXTRACT', `ENUM [${name}]: [${values.join(', ')}]`);
  }

  // 리포트 생성
  const report = { timestamp: new Date().toISOString(), apis: {}, enums };
  const relatedModules = modules.map(m => basename(m.path));

  let targets = apiCalls;
  if (options.filter) {
    targets = apiCalls.filter(c => options.filter.some(f => c.url.includes(f)));
  }

  for (const call of targets) {
    report.apis[`${call.method} ${call.url}`] = {
      method: call.method,
      pathParams: call.pathParams,
      queryParams: call.queryParams,
      bodyFields: call.bodyFields,
      contentType: call.contentType,
      errorMessages: call.errorMessages,
      source: call.source,
    };
  }
  report.relatedModules = relatedModules;

  await ensureDir(outputDir);
  await writeJson(REPORT_PATH, report);
  log('EXTRACT', `report.json 저장 (API ${Object.keys(report.apis).length}개)`);
  return report;
}

// ── API 호출 추출 ──────────────────────────────

function extractApiCalls(modules) {
  const calls = [];
  const re = /httpV2\.(get|post|patch|put|delete)\(\s*[`"']([^`"']+)/g;

  for (const { code, path } of modules) {
    const lines = code.split('\n');
    let m;

    while ((m = re.exec(code)) !== null) {
      const method = m[1].toUpperCase();
      const url = normalizeUrl(m[2]);
      const lineNum = code.substring(0, m.index).split('\n').length;
      const after = code.substring(m.index, m.index + 300);
      const before = lines.slice(Math.max(0, lineNum - 30), lineNum).join('\n');
      const post = lines.slice(lineNum, lineNum + 20).join('\n');
      const pathParams = [...url.matchAll(/\{(\w+)\}/g)].map(x => x[1]);

      calls.push({
        method, url,
        pathParams: pathParams.length ? pathParams : null,
        queryParams: parseQueryParams(after),
        bodyFields: parseBodyFields(before, method),
        contentType: after.match(/"Content-Type":\s*"([^"]+)"/)?.[1] || null,
        errorMessages: parseErrors(post),
        source: `${basename(path)}:L${lineNum}`,
      });
    }

    re.lastIndex = 0;
  }

  return calls;
}

// /me/cohorts/${e}/attendance/today → /api/v2/me/cohorts/{cohortId}/attendance/today
function normalizeUrl(raw) {
  let url = raw.startsWith('/api/') ? raw : `/api/v2${raw.startsWith('/') ? '' : '/'}${raw}`;
  return url.replace(/\$\{[^}]+\}/g, (_, offset) => {
    const prev = url.substring(0, offset).split('/').filter(Boolean).pop() || 'id';
    const name = prev.replace(/s$/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return `{${name}Id}`;
  });
}

function parseQueryParams(snippet) {
  const m = snippet.match(/params:\s*\{([^}]+)\}/);
  if (!m) return null;
  const params = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*([^,}]+)/g)) {
    const def = v.match(/\?\?\s*(\d+)/);
    params[k] = def ? { default: +def[1] } : {};
  }
  return Object.keys(params).length ? params : null;
}

function parseBodyFields(before, method) {
  if (method === 'GET' || method === 'DELETE') return null;
  const fields = [...new Set([...before.matchAll(/\.append\("(\w+)"/g)].map(m => m[1]))];
  return fields.length ? fields : null;
}

function parseErrors(block) {
  const errors = {};
  for (const [, code] of block.matchAll(/status\s*===\s*(\d{3})/g)) {
    const idx = block.indexOf(`status === ${code}`);
    errors[code] = block.substring(idx, idx + 200).match(/Error\("([^"]+)"\)/)?.[1] || null;
  }
  const generic = block.match(/isHttpError\).*?\n.*?throw\s+Error\("([^"]+)"\)/);
  if (generic) errors.generic = generic[1];
  return Object.keys(errors).length ? errors : null;
}

// ── ENUM 추출 ──────────────────────────────────

function extractEnums(modules) {
  const groups = {};

  for (const { code } of modules) {
    const re = /^\s*(\w+)\s*:\s*\{/gm;
    let m, current = [], lastLine = -1;

    while ((m = re.exec(code)) !== null) {
      const key = m[1];
      const line = code.substring(0, m.index).split('\n').length;

      if (!ENUM_KEY_RE.test(key)) {
        flushEnum(current, groups);
        current = [];
        lastLine = -1;
        continue;
      }

      if (lastLine >= 0 && line - lastLine > 10) {
        flushEnum(current, groups);
        current = [];
      }
      current.push(key);
      lastLine = line;
    }
    flushEnum(current, groups);
  }

  return groups;
}

function flushEnum(keys, groups) {
  if (keys.length < 2) return;
  const name = keys.some(k => ['PRESENT', 'ABSENT', 'LATE', 'SELF_STUDY'].includes(k))
    ? 'attendance_status'
    : keys.some(k => ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'].includes(k))
    ? 'leave_request_status'
    : `enum_${Object.keys(groups).length}`;
  groups[name] = [...new Set([...(groups[name] || []), ...keys])].sort();
}
