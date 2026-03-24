export function assert(condition, stage, message, context = {}) {
  if (!condition) {
    const detail = Object.keys(context).length ? '\n' + JSON.stringify(context, null, 2) : '';
    throw new Error(`[${stage}] ${message}${detail}`);
  }
}

export function assertNonEmpty(arr, stage, label) {
  assert(Array.isArray(arr) && arr.length > 0, stage, `${label}이 비어있음`);
}

export function assertHasKeys(obj, keys, stage, label) {
  const missing = keys.filter(k => !(k in obj));
  assert(missing.length === 0, stage, `${label}에 필수 키 누락: ${missing.join(', ')}`);
}
