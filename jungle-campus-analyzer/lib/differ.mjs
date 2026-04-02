import { execSync } from 'node:child_process';
import { relative } from 'node:path';
import { log } from './utils.mjs';

// git에 커밋된 이전 report.json 읽기
export function loadPreviousReport(reportPath) {
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const relPath = relative(root, reportPath);
    const json = execSync(`git show "HEAD:${relPath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(json);
  } catch {
    return null; // 첫 실행이거나 git에 없음
  }
}

// 구조적 diff
export function diff(oldReport, newReport) {
  if (!oldReport) {
    const changes = [];
    for (const api of Object.keys(newReport.apis || {})) {
      changes.push({ type: 'api_added', detail: api });
    }
    for (const [name, vals] of Object.entries(newReport.enums || {})) {
      changes.push({ type: 'enum_added', detail: `${name} +${vals.join(', +')}` });
    }
    return { firstRun: true, hasChanges: true, changes };
  }

  const changes = [];

  // API 추가/삭제
  const oldApis = new Set(Object.keys(oldReport.apis || {}));
  const newApis = new Set(Object.keys(newReport.apis || {}));

  for (const api of newApis) {
    if (!oldApis.has(api)) changes.push({ type: 'api_added', detail: api });
  }
  for (const api of oldApis) {
    if (!newApis.has(api)) changes.push({ type: 'api_removed', detail: api });
  }

  // API 필드 변경 (queryParams, errorMessages 등)
  for (const api of newApis) {
    if (!oldApis.has(api)) continue;
    const oldApi = oldReport.apis[api];
    const newApi = newReport.apis[api];
    for (const field of ['queryParams', 'errorMessages', 'bodyFields', 'contentType']) {
      if (JSON.stringify(oldApi[field]) !== JSON.stringify(newApi[field])) {
        changes.push({ type: 'api_changed', detail: `${api} → ${field}` });
      }
    }
  }

  // ENUM 변경
  const oldEnums = oldReport.enums || {};
  const newEnums = newReport.enums || {};

  for (const name of new Set([...Object.keys(oldEnums), ...Object.keys(newEnums)])) {
    const oldVals = oldEnums[name] || [];
    const newVals = newEnums[name] || [];
    const added = newVals.filter(v => !oldVals.includes(v));
    const removed = oldVals.filter(v => !newVals.includes(v));
    if (added.length) changes.push({ type: 'enum_added', detail: `${name} +${added.join(', +')}` });
    if (removed.length) changes.push({ type: 'enum_removed', detail: `${name} -${removed.join(', -')}` });
  }

  return { firstRun: false, hasChanges: changes.length > 0, changes };
}

// 변경 로그 출력
export function logChanges(result) {
  if (result.firstRun) {
    log('DIFF', '첫 실행 — 비교 대상 없음');
    return;
  }
  if (!result.hasChanges) {
    log('DIFF', '변경 없음');
    return;
  }
  log('DIFF', `변경 ${result.changes.length}건 감지:`);
  for (const c of result.changes) {
    log('DIFF', `  ${c.type}: ${c.detail}`);
  }
}

