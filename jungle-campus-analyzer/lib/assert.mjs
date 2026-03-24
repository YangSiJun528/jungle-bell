import { existsSync } from 'node:fs';

/** 조건 실패 시 stage 이름 + 메시지를 포함한 에러를 throw */
export function assert(condition, stage, message, context = {}) {
  if (!condition) {
    const detail = Object.keys(context).length
      ? '\n' + JSON.stringify(context, null, 2)
      : '';
    throw new Error(`[${stage}] Assertion failed: ${message}${detail}`);
  }
}

/** 값이 특정 타입인지 확인 */
export function assertType(value, type, stage, label) {
  assert(typeof value === type, stage, `${label}의 타입이 ${type}이어야 함 (실제: ${typeof value})`);
}

/** 배열이 비어있지 않은지 확인 */
export function assertNonEmpty(arr, stage, label) {
  assert(Array.isArray(arr) && arr.length > 0, stage, `${label}이 비어있음`, { length: arr?.length });
}

/** 파일이 존재하는지 확인 */
export function assertFileExists(filePath, stage) {
  assert(existsSync(filePath), stage, `파일 미존재: ${filePath}`);
}

/** 객체가 필수 키를 포함하는지 확인 */
export function assertHasKeys(obj, keys, stage, label) {
  const missing = keys.filter(k => !(k in obj));
  assert(missing.length === 0, stage, `${label}에 필수 키 누락`, { missing, actual: Object.keys(obj) });
}
