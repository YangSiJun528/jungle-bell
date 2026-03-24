import { readFileSync, writeFileSync, copyFileSync, globSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { assert, assertNonEmpty, assertHasKeys, assertType } from './assert.mjs';
import { log, debug, ensureDir, writeJson, readJson, API_REQUESTS_PATH, REPORT_PATH } from './utils.mjs';

// ── 키워드 ──────────────────────────────────────
const PRIMARY_KEYWORDS = ['/api/v2/me/cohorts', '/attendance/today'];
const SECONDARY_KEYWORDS = [
  'PRESENT', 'ABSENT', 'LATE', 'status', 'checkedAt',
  'checkedOutAt', 'isStudying', 'isActive', 'cohortClassId',
  'cohortClassName', 'enrolledAt',
];

// ENUM 스타일 판별: 대문자 + 언더스코어로 구성된 식별자 (2자 이상)
const ENUM_STYLE_RE = /^[A-Z][A-Z_]{1,}$/;

// CUID 패턴: path에서 cohortId 등을 정규화할 때 사용
const CUID_RE = /c[a-z0-9]{20,}/;

export async function extract(unminifiedDir, outputDir, options = {}) {
  const { filter } = options;

  // 모든 모듈 파일 수집
  const allModules = globSync(join(unminifiedDir, '**/*.js').replace(/\\/g, '/'));
  if (allModules.length === 0) {
    log('EXTRACT', '[WARN] unminified 디렉토리에 모듈 없음 — debundled에서 직접 검색');
    const debundledDir = unminifiedDir.replace('unminified', 'debundled');
    allModules.push(...globSync(join(debundledDir, '**/*.js').replace(/\\/g, '/')));
  }
  assertNonEmpty(allModules, 'EXTRACT', 'unminified/debundled 내 모듈 파일');

  // ── 모듈 필터링 (ENUM/UI 분석용) ──
  const matchedModules = filterModules(allModules, PRIMARY_KEYWORDS, SECONDARY_KEYWORDS);
  assertNonEmpty(matchedModules, 'EXTRACT', 'API 관련 모듈 — 키워드 매칭 결과 0건', {
    totalScanned: allModules.length,
  });
  log('EXTRACT', `${allModules.length}개 모듈 중 ${matchedModules.length}개 키워드 매칭`);

  // ── httpV2 호출 포함 모듈 탐색 (정적 API 분석용) ──
  const apiModules = findApiModules(allModules);
  log('EXTRACT', `httpV2 호출 포함 모듈: ${apiModules.length}개`);

  // 매칭 모듈 + API 모듈 합집합 → output/api-modules/ 복사
  await ensureDir(outputDir);
  const allRelevant = dedupeModules([...matchedModules, ...apiModules]);
  const relatedModuleNames = [];
  for (const mod of allRelevant) {
    const name = basename(mod.filePath);
    const dest = join(outputDir, name);
    copyFileSync(mod.filePath, dest);
    relatedModuleNames.push(name);
  }

  // ── 정적 API 호출 추출 ──
  const apiCalls = extractApiCalls(apiModules);
  log('EXTRACT', `정적 API 호출 ${apiCalls.length}개 추출`);
  for (const call of apiCalls) {
    debug('EXTRACT', `  ${call.method} ${call.urlTemplate} (${call.source})`);
  }

  // ── ENUM 추출 ──
  const allCode = matchedModules.map(m => m.code).join('\n');
  const extractedEnums = extractEnums(allCode, matchedModules);

  const enumGroupNames = Object.keys(extractedEnums);
  assert(enumGroupNames.length > 0, 'EXTRACT',
    'ENUM 그룹을 1개도 찾지 못함 — 코드 구조 변경 확인 필요', {
      matchedModuleCount: matchedModules.length,
    });
  for (const [name, group] of Object.entries(extractedEnums)) {
    log('EXTRACT', `ENUM [${name}]: [${group.foundValues.join(', ')}]`);
  }

  // ── API 응답 데이터 로드 (런타임 캡처) ──
  const rawApiData = existsSync(API_REQUESTS_PATH)
    ? JSON.parse(readFileSync(API_REQUESTS_PATH, 'utf-8'))
    : {};

  // ── 리포트 생성 ──
  const report = buildReport(rawApiData, apiCalls, extractedEnums, relatedModuleNames, filter);

  // report 스키마 검증
  assertHasKeys(report, ['timestamp', 'apis'], 'EXTRACT', 'report 최상위');
  assertType(report.timestamp, 'string', 'EXTRACT', 'report.timestamp');

  for (const [path, api] of Object.entries(report.apis)) {
    assertHasKeys(api, ['request', 'response', 'relatedModules'], 'EXTRACT', `report.apis["${path}"]`);
    assert(api.request.method, 'EXTRACT', `${path}.request.method 누락`);
  }
  log('EXTRACT', 'report.json 스키마 검증 통과');

  await writeJson(REPORT_PATH, report);
  log('EXTRACT', `report.json 저장: ${REPORT_PATH}`);

  return report;
}

// ══════════════════════════════════════════════════
// 모듈 탐색
// ══════════════════════════════════════════════════

function filterModules(allModules, primary, secondary) {
  const matched = [];
  for (const filePath of allModules) {
    const code = readFileSync(filePath, 'utf-8');
    const primaryHits = primary.filter(kw => code.includes(kw)).length;
    const secondaryHits = secondary.filter(kw => code.includes(kw)).length;
    if (primaryHits >= 1 || secondaryHits >= 2) {
      matched.push({ filePath, code, primaryHits, secondaryHits });
    }
  }
  return matched;
}

function findApiModules(allModules) {
  const matched = [];
  for (const filePath of allModules) {
    const code = readFileSync(filePath, 'utf-8');
    if (code.includes('httpV2.')) {
      matched.push({ filePath, code });
    }
  }
  return matched;
}

function dedupeModules(modules) {
  const seen = new Set();
  return modules.filter(m => {
    if (seen.has(m.filePath)) return false;
    seen.add(m.filePath);
    return true;
  });
}

// ══════════════════════════════════════════════════
// 정적 API 호출 추출
// ══════════════════════════════════════════════════

function extractApiCalls(apiModules) {
  const calls = [];

  for (const { code, filePath } of apiModules) {
    const lines = code.split('\n');
    const methodRe = /httpV2\.(get|post|patch|put|delete)\(\s*[`"']([^`"']+)/g;
    let m;

    while ((m = methodRe.exec(code)) !== null) {
      const method = m[1].toUpperCase();
      const rawUrl = m[2];
      const lineNum = lineOfIndex(code, m.index);
      const urlTemplate = normalizeUrlTemplate(rawUrl);

      // 호출 이전 코드 (body/FormData 탐색용)
      const preStart = Math.max(0, lineNum - 30);
      const preBlock = lines.slice(preStart, lineNum).join('\n');

      // 호출 이후 코드 (에러 핸들링 탐색용)
      const postEnd = Math.min(lines.length, lineNum + 20);
      const postBlock = lines.slice(lineNum, postEnd).join('\n');

      // query params (GET 호출의 { params: { ... } })
      const queryParams = extractQueryParams(code, m.index);

      // request body (FormData 또는 객체)
      const bodyInfo = extractBodyFields(preBlock, method);

      // Content-Type
      const contentType = extractContentType(code, m.index);

      // 에러 메시지 (호출 이후 catch 블록에서만)
      const errorMessages = extractErrorMessages(postBlock);

      calls.push({
        method,
        urlTemplate,
        pathParams: extractPathParams(urlTemplate),
        queryParams,
        bodyFields: bodyInfo,
        contentType,
        errorMessages,
        source: `${basename(filePath)}:L${lineNum}`,
      });
    }
  }

  return calls;
}

function normalizeUrlTemplate(rawUrl) {
  // /me/cohorts/${e}/attendance/today → /api/v2/me/cohorts/{cohortId}/attendance/today
  let url = rawUrl;

  // httpV2 클라이언트는 /api/v2 base path를 자동 추가
  if (!url.startsWith('/api/')) {
    url = '/api/v2' + (url.startsWith('/') ? '' : '/') + url;
  }

  // 템플릿 변수 치환: 경로 구조 기반 이름 부여
  // 첫 번째 ${...} 는 cohorts 뒤이므로 cohortId
  let paramIndex = 0;
  url = url.replace(/\$\{[^}]+\}/g, (match, offset) => {
    const before = url.substring(0, offset);
    const segments = before.split('/').filter(Boolean);
    const precedingSegment = segments[segments.length - 1] || 'id';

    // cohorts → cohortId, leave-requests → leaveRequestId
    const base = precedingSegment.replace(/s$/, '');
    // 하이픈을 camelCase로: leave-request → leaveRequest
    const paramName = base.replace(/-(\w)/g, (_, c) => c.toUpperCase()) + 'Id';
    paramIndex++;
    return `{${paramName}}`;
  });

  return url;
}

function extractPathParams(urlTemplate) {
  const params = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(urlTemplate)) !== null) {
    params.push(m[1]);
  }
  return params.length > 0 ? params : null;
}

function extractQueryParams(code, callIndex) {
  // httpV2.get(..., { params: { page: ..., pageSize: ... } }) 패턴
  // 호출 지점부터 200자 이내에서 params 찾기
  const snippet = code.substring(callIndex, callIndex + 300);
  const paramsMatch = snippet.match(/params:\s*\{([^}]+)\}/);
  if (!paramsMatch) return null;

  const params = {};
  const fieldRe = /(\w+)\s*:\s*([^,}]+)/g;
  let m;
  while ((m = fieldRe.exec(paramsMatch[1])) !== null) {
    const name = m[1].trim();
    const valueExpr = m[2].trim();
    // 기본값 추출: t?.page ?? 1 → default: 1
    const defaultMatch = valueExpr.match(/\?\?\s*(\d+)/);
    params[name] = defaultMatch ? { default: parseInt(defaultMatch[1]) } : {};
  }
  return Object.keys(params).length > 0 ? params : null;
}

function extractBodyFields(contextBlock, method) {
  if (method === 'GET' || method === 'DELETE') return null;

  // FormData 패턴: .append("fieldName", ...)
  const formDataFields = [];
  const appendRe = /\.append\("(\w+)"/g;
  let m;
  while ((m = appendRe.exec(contextBlock)) !== null) {
    if (!formDataFields.includes(m[1])) {
      formDataFields.push(m[1]);
    }
  }
  if (formDataFields.length > 0) return formDataFields;

  // httpV2.post(url, body, config) — body가 변수면 추적 어려움, null 반환
  return null;
}

function extractContentType(code, callIndex) {
  const snippet = code.substring(callIndex, callIndex + 300);
  const ctMatch = snippet.match(/"Content-Type":\s*"([^"]+)"/);
  return ctMatch ? ctMatch[1] : null;
}

function extractErrorMessages(contextBlock) {
  const errors = {};
  // status === 400 패턴 + 직후 throw Error("...") 캡처
  const statusRe = /status\s*===\s*(\d{3})/g;
  let m;
  while ((m = statusRe.exec(contextBlock)) !== null) {
    const statusCode = m[1];
    // 이 매칭 이후 가장 가까운 throw Error("...") 또는 Error("...")
    const afterMatch = contextBlock.substring(m.index, m.index + 200);
    const msgMatch = afterMatch.match(/(?:throw\s+)?Error\("([^"]+)"\)/);
    errors[statusCode] = msgMatch ? msgMatch[1] : null;
  }

  // 일반 catch 에러 메시지 (status 체크 없는 isHttpError)
  const genericMatch = contextBlock.match(/isHttpError\).*?\n.*?throw\s+Error\("([^"]+)"\)/);
  if (genericMatch && !errors['generic']) {
    errors['generic'] = genericMatch[1];
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

// ══════════════════════════════════════════════════
// ENUM 추출
// ══════════════════════════════════════════════════

function extractEnums(allCode, matchedModules) {
  const enumGroups = new Map();

  for (const mod of matchedModules) {
    const { code, filePath } = mod;
    const lines = code.split('\n');
    let m;

    detectMappingObjects(code, filePath, lines, enumGroups);

    const flatRe = /\{([^{}]+)\}/g;
    while ((m = flatRe.exec(code)) !== null) {
      const pairs = [...m[1].matchAll(/(\w+)\s*:\s*"(\w+)"/g)]
        .filter(([, k]) => ENUM_STYLE_RE.test(k));
      if (pairs.length >= 2) {
        const groupName = inferGroupName(pairs.map(([, k]) => k), enumGroups);
        const group = getOrCreateGroup(enumGroups, groupName);
        for (const [, key] of pairs) group.values.add(key);
        if (!group.source) {
          group.source = `${basename(filePath)}:L${lineOfIndex(code, m.index)}`;
          group.raw = m[0].substring(0, 200);
        }
      }
    }

    const iifeRe = /\w+\["(\w+)"\]\s*=\s*"(\w+)"/g;
    while ((m = iifeRe.exec(code)) !== null) {
      if (ENUM_STYLE_RE.test(m[2])) addToNearestGroup(enumGroups, m[2], filePath, code, m.index);
    }

    const caseRe = /case\s+"(\w+)"\s*:/g;
    while ((m = caseRe.exec(code)) !== null) {
      if (ENUM_STYLE_RE.test(m[1])) addToNearestGroup(enumGroups, m[1], filePath, code, m.index);
    }

    const eqRe = /===\s*"(\w+)"/g;
    while ((m = eqRe.exec(code)) !== null) {
      if (ENUM_STYLE_RE.test(m[1])) addToNearestGroup(enumGroups, m[1], filePath, code, m.index);
    }
  }

  const enums = {};
  for (const [name, group] of enumGroups) {
    enums[name] = { foundValues: [...group.values].sort(), source: group.source, raw: group.raw };
  }
  if (!enums.status) {
    const att = Object.entries(enums).find(([, g]) => g.foundValues.includes('PRESENT'));
    if (att) enums.status = att[1];
  }
  return enums;
}

function detectMappingObjects(code, filePath, lines, enumGroups) {
  const keyRe = /^(\s*)(\w+)\s*:\s*\{/gm;
  let m;
  let currentGroup = [];
  let lastEndLine = -1;

  while ((m = keyRe.exec(code)) !== null) {
    const key = m[2];
    if (!ENUM_STYLE_RE.test(key)) {
      flushGroup(currentGroup, filePath, code, enumGroups);
      currentGroup = [];
      lastEndLine = -1;
      continue;
    }
    const lineNum = lineOfIndex(code, m.index);
    if (lastEndLine >= 0 && lineNum - lastEndLine > 10) {
      flushGroup(currentGroup, filePath, code, enumGroups);
      currentGroup = [];
    }
    currentGroup.push({ key, lineNum, index: m.index });
    lastEndLine = lineNum;
  }
  flushGroup(currentGroup, filePath, code, enumGroups);
}

function flushGroup(group, filePath, code, enumGroups) {
  if (group.length < 2) return;
  const values = group.map(g => g.key);
  const name = inferGroupName(values, enumGroups);
  const enumGroup = getOrCreateGroup(enumGroups, name);
  for (const v of values) enumGroup.values.add(v);
  if (!enumGroup.source) {
    enumGroup.source = `${basename(filePath)}:L${group[0].lineNum}`;
    enumGroup.raw = code.substring(group[0].index, group[0].index + 200);
  }
}

function getOrCreateGroup(groups, name) {
  if (!groups.has(name)) groups.set(name, { values: new Set(), source: null, raw: null });
  return groups.get(name);
}

function inferGroupName(values, existingGroups) {
  for (const [name, group] of existingGroups) {
    if (values.some(v => group.values.has(v))) return name;
  }
  if (values.some(v => ['PRESENT', 'ABSENT', 'LATE', 'SELF_STUDY'].includes(v))) return 'attendance_status';
  if (values.some(v => ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'].includes(v))) return 'leave_request_status';
  return `enum_${existingGroups.size}`;
}

function addToNearestGroup(groups, value, filePath, code, index) {
  for (const [, group] of groups) {
    if (group.values.has(value)) return;
  }
  const misc = getOrCreateGroup(groups, 'ungrouped');
  misc.values.add(value);
  if (!misc.source) misc.source = `${basename(filePath)}:L${lineOfIndex(code, index)}`;
}

function lineOfIndex(code, index) {
  return code.substring(0, index).split('\n').length;
}

// ══════════════════════════════════════════════════
// 타입 추론
// ══════════════════════════════════════════════════

function inferType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'string (ISO 8601)';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'string (YYYY-MM-DD)';
    if (/^c[a-z0-9]{20,}$/.test(value)) return 'string (CUID)';
    if (/^[A-Z_]+$/.test(value)) return 'string (ENUM)';
    return 'string';
  }
  return t;
}

function inferFieldTypes(obj) {
  const types = {};
  if (!obj || typeof obj !== 'object') return types;
  const target = Array.isArray(obj) ? obj[0] : obj;
  if (!target || typeof target !== 'object') return types;
  for (const [key, value] of Object.entries(target)) {
    types[key] = value === null ? 'nullable' : inferType(value);
  }
  return types;
}

// ══════════════════════════════════════════════════
// 경로 정규화
// ══════════════════════════════════════════════════

function normalizeRuntimePath(path) {
  // /api/v2/me/cohorts/cmlkegjxa003m016xu0c9n4n7/attendance/today
  // → /api/v2/me/cohorts/{cohortId}/attendance/today
  let result = path;
  const segments = result.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (CUID_RE.test(segments[i])) {
      const preceding = segments[i - 1] || 'resource';
      const base = preceding.replace(/s$/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
      segments[i] = `{${base}Id}`;
    }
  }
  return segments.join('/');
}

// ══════════════════════════════════════════════════
// 리포트 생성
// ══════════════════════════════════════════════════

function buildReport(rawApiData, apiCalls, enums, relatedModules, filter) {
  const report = { timestamp: new Date().toISOString(), apis: {} };

  // 1. 런타임 캡처 path 수집 (정규화)
  const runtimeMap = new Map(); // normalizedPath → { method, response, ... }
  for (const [path, entry] of Object.entries(rawApiData)) {
    const normalized = normalizeRuntimePath(path);
    // 하위 호환: old format (response JSON 직접) vs new format ({ method, response, ... })
    const isNewFormat = entry && typeof entry === 'object' && 'response' in entry;
    runtimeMap.set(normalized, {
      method: isNewFormat ? entry.method : 'GET',
      queryString: isNewFormat ? entry.queryString : null,
      postData: isNewFormat ? entry.postData : null,
      response: isNewFormat ? entry.response : entry,
      originalPath: path,
    });
  }

  // 2. 정적 분석 path 수집
  const staticMap = new Map(); // urlTemplate → apiCall
  for (const call of apiCalls) {
    // 같은 URL에 여러 method가 있을 수 있음 (GET + POST 등)
    const key = `${call.method} ${call.urlTemplate}`;
    staticMap.set(key, call);
  }

  // 3. 모든 path 합집합
  const allPaths = new Set();
  for (const path of runtimeMap.keys()) allPaths.add(path);
  for (const call of apiCalls) allPaths.add(call.urlTemplate);

  // filter 적용
  const targetPaths = filter
    ? [...allPaths].filter(p => filter.some(f => p.includes(f)))
    : [...allPaths];

  // 4. 각 path에 대해 엔트리 생성
  for (const normalizedPath of targetPaths.sort()) {
    const runtime = runtimeMap.get(normalizedPath);
    // 이 path에 해당하는 정적 호출 찾기
    const matchingCalls = apiCalls.filter(c => c.urlTemplate === normalizedPath);

    if (matchingCalls.length === 0 && runtime) {
      // 런타임에서만 캡처됨 (정적 분석에서 발견 못 함)
      const responseData = runtime.response;
      report.apis[`${runtime.method} ${normalizedPath}`] = {
        request: {
          method: runtime.method,
          pathParams: extractPathParams(normalizedPath),
          queryParams: null,
          bodyFields: null,
          contentType: null,
          errorMessages: null,
        },
        response: {
          capturedData: responseData,
          fields: responseData ? Object.keys(Array.isArray(responseData) ? responseData[0] || {} : responseData) : [],
          fieldTypes: inferFieldTypes(responseData),
        },
        enums: getEnumsForPath(normalizedPath, enums),
        relatedModules,
      };
    } else {
      // 정적 분석 기반 (+ 런타임 데이터 머지)
      for (const call of matchingCalls) {
        // 동일 path에 여러 method가 있으면 path로만 key를 쓸 수 없으므로 항상 METHOD path 형태
        const key = `${call.method} ${normalizedPath}`;

        const responseData = runtime?.response ?? null;

        report.apis[key] = {
          request: {
            method: call.method,
            pathParams: call.pathParams,
            queryParams: call.queryParams,
            bodyFields: call.bodyFields,
            contentType: call.contentType,
            errorMessages: call.errorMessages,
            source: call.source,
          },
          response: {
            capturedData: responseData,
            fields: responseData ? Object.keys(Array.isArray(responseData) ? responseData[0] || {} : responseData) : [],
            fieldTypes: inferFieldTypes(responseData),
          },
          enums: getEnumsForPath(normalizedPath, enums),
          relatedModules,
        };
      }
    }
  }

  return report;
}

function getEnumsForPath(path, allEnums) {
  if (path.includes('/attendance')) return allEnums;
  if (path.includes('/leave-request')) {
    const relevant = {};
    if (allEnums.leave_request_status) relevant.leave_request_status = allEnums.leave_request_status;
    return relevant;
  }
  return {};
}
