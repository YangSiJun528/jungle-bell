import type {
  DiffResult,
  EndpointReport,
  ObserverReport,
  SchemaNode,
  SemanticChange,
  StaticClientError,
} from './types.ts';

export function diffReports(oldReport: ObserverReport | null, newReport: ObserverReport): DiffResult {
  if (!oldReport) {
    const changes: SemanticChange[] = [
      ...Object.keys(newReport.endpoints).map((endpoint) => ({ type: 'api_added' as const, endpoint, detail: endpoint })),
      ...newReport.enums.map((item) => ({ type: 'enum_added' as const, detail: `${item.id}: ${item.values.join(', ')}` })),
    ];
    return { firstRun: true, hasChanges: changes.length > 0, changes };
  }

  const changes: SemanticChange[] = [];
  const oldKeys = new Set(Object.keys(oldReport.endpoints));
  const newKeys = new Set(Object.keys(newReport.endpoints));

  for (const endpoint of newKeys) {
    if (!oldKeys.has(endpoint)) changes.push({ type: 'api_added', endpoint, detail: endpoint });
  }
  for (const endpoint of oldKeys) {
    if (!newKeys.has(endpoint)) changes.push({ type: 'api_removed', endpoint, detail: endpoint });
  }

  for (const endpoint of newKeys) {
    const oldEndpoint = oldReport.endpoints[endpoint];
    const newEndpoint = newReport.endpoints[endpoint];
    if (!oldEndpoint || !newEndpoint) continue;

    if (stableJson(oldEndpoint.request) !== stableJson(newEndpoint.request)) {
      changes.push({
        type: 'request_changed',
        endpoint,
        detail: `${endpoint} 요청 계약 변경`,
        before: oldEndpoint.request,
        after: newEndpoint.request,
      });
    }

    compareClientErrors(endpoint, oldEndpoint.errors, newEndpoint.errors, changes);
    compareObservedErrors(endpoint, oldEndpoint, newEndpoint, changes);
    compareResponses(endpoint, oldEndpoint, newEndpoint, changes);
  }

  compareEnums(oldReport, newReport, changes);
  changes.sort((left, right) => `${left.endpoint ?? ''}:${left.type}:${left.detail}`.localeCompare(`${right.endpoint ?? ''}:${right.type}:${right.detail}`));
  return { firstRun: false, hasChanges: changes.length > 0, changes };
}

function compareObservedErrors(
  endpoint: string,
  oldEndpoint: EndpointReport,
  newEndpoint: EndpointReport,
  changes: SemanticChange[],
): void {
  const oldByStatus = new Map(oldEndpoint.observedErrors.map((error) => [error.status, error]));
  const newByStatus = new Map(newEndpoint.observedErrors.map((error) => [error.status, error]));
  const statuses = new Set([...oldByStatus.keys(), ...newByStatus.keys()]);

  for (const status of statuses) {
    const previous = oldByStatus.get(status);
    const current = newByStatus.get(status);
    compareObservedValues(
      endpoint,
      status,
      'code',
      previous?.errorCodes ?? [],
      current?.errorCodes ?? [],
      changes,
    );
    compareObservedValues(
      endpoint,
      status,
      'message',
      previous?.messages ?? [],
      current?.messages ?? [],
      changes,
    );
  }
}

function compareObservedValues(
  endpoint: string,
  status: number,
  kind: 'code' | 'message',
  previous: string[],
  current: string[],
  changes: SemanticChange[],
): void {
  for (const value of current) {
    if (previous.includes(value)) continue;
    changes.push({
      type: kind === 'code' ? 'observed_error_code_added' : 'observed_error_message_added',
      endpoint,
      detail: `${endpoint} [${status}] 오류 ${kind === 'code' ? '코드' : '메시지'} 추가: ${value}`,
      after: value,
    });
  }
  for (const value of previous) {
    if (current.includes(value)) continue;
    changes.push({
      type: kind === 'code' ? 'observed_error_code_removed' : 'observed_error_message_removed',
      endpoint,
      detail: `${endpoint} [${status}] 오류 ${kind === 'code' ? '코드' : '메시지'} 미관찰: ${value}`,
      before: value,
    });
  }
}

export function logChanges(result: DiffResult): void {
  if (result.firstRun) {
    console.log(`[DIFF] 첫 실행 — 기준 스냅샷 없음 (${result.changes.length}건)`);
    return;
  }
  if (!result.hasChanges) {
    console.log('[DIFF] 의미 변경 없음');
    return;
  }
  console.log(`[DIFF] 의미 변경 ${result.changes.length}건:`);
  for (const change of result.changes) {
    const impact = change.appImpact ? ' [APP IMPACT]' : '';
    console.log(`[DIFF]   ${change.type}${impact}: ${change.detail}`);
  }
}

function compareClientErrors(
  endpoint: string,
  oldErrors: StaticClientError[],
  newErrors: StaticClientError[],
  changes: SemanticChange[],
): void {
  const oldByCondition = new Map(oldErrors.map((error) => [errorConditionKey(error), error]));
  const newByCondition = new Map(newErrors.map((error) => [errorConditionKey(error), error]));

  for (const [key, error] of newByCondition) {
    const previous = oldByCondition.get(key);
    if (!previous) {
      changes.push({ type: 'client_error_added', endpoint, detail: `${endpoint}: ${describeError(error)}` });
    } else if (previous.clientMessage !== error.clientMessage) {
      changes.push({
        type: 'client_message_changed',
        endpoint,
        detail: `${endpoint}: ${describeErrorCondition(error)} 메시지 변경`,
        before: previous.clientMessage,
        after: error.clientMessage,
      });
    }
  }
  for (const [key, error] of oldByCondition) {
    if (!newByCondition.has(key)) changes.push({ type: 'client_error_removed', endpoint, detail: `${endpoint}: ${describeError(error)}` });
  }
}

function compareResponses(
  endpoint: string,
  oldEndpoint: EndpointReport,
  newEndpoint: EndpointReport,
  changes: SemanticChange[],
): void {
  const oldStatuses = new Set(Object.keys(oldEndpoint.responses));
  const newStatuses = new Set(Object.keys(newEndpoint.responses));
  for (const status of newStatuses) {
    if (!oldStatuses.has(status)) {
      changes.push({ type: 'response_status_added', endpoint, detail: `${endpoint}: 응답 ${status} 관찰` });
    }
  }
  for (const status of oldStatuses) {
    if (!newStatuses.has(status)) {
      changes.push({ type: 'response_status_removed', endpoint, detail: `${endpoint}: 응답 ${status} 미관찰` });
    }
  }
  for (const status of newStatuses) {
    const oldSchema = oldEndpoint.responses[status];
    const newSchema = newEndpoint.responses[status];
    if (oldSchema && newSchema) compareSchema(endpoint, status, '', oldSchema, newSchema, newEndpoint, changes);
  }
}

function compareSchema(
  endpoint: string,
  status: string,
  path: string,
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  endpointReport: EndpointReport,
  changes: SemanticChange[],
): void {
  if (stableJson([...oldSchema.types].sort()) !== stableJson([...newSchema.types].sort())) {
    changes.push({
      type: 'response_type_changed',
      endpoint,
      field: path || '$',
      detail: `${endpoint} [${status}] ${path || '$'}: ${oldSchema.types.join('|')} → ${newSchema.types.join('|')}`,
      before: oldSchema.types,
      after: newSchema.types,
      appImpact: isAppImpact(path, endpointReport),
    });
  }

  const oldProperties = oldSchema.properties ?? {};
  const newProperties = newSchema.properties ?? {};
  const oldKeys = new Set(Object.keys(oldProperties));
  const newKeys = new Set(Object.keys(newProperties));
  for (const key of newKeys) {
    const field = path ? `${path}.${key}` : key;
    if (!oldKeys.has(key)) {
      changes.push({
        type: 'response_field_added',
        endpoint,
        field,
        detail: `${endpoint} [${status}] +${field}`,
        after: newProperties[key],
        appImpact: isAppImpact(field, endpointReport),
      });
    }
  }
  for (const key of oldKeys) {
    const field = path ? `${path}.${key}` : key;
    if (!newKeys.has(key)) {
      changes.push({
        type: 'response_field_removed',
        endpoint,
        field,
        detail: `${endpoint} [${status}] -${field}`,
        before: oldProperties[key],
        appImpact: isAppImpact(field, endpointReport),
      });
    }
  }
  for (const key of newKeys) {
    if (oldProperties[key] && newProperties[key]) {
      compareSchema(endpoint, status, path ? `${path}.${key}` : key, oldProperties[key], newProperties[key], endpointReport, changes);
    }
  }

  if (oldSchema.items && newSchema.items) {
    compareSchema(endpoint, status, path ? `${path}[]` : '[]', oldSchema.items, newSchema.items, endpointReport, changes);
  }
}

function compareEnums(oldReport: ObserverReport, newReport: ObserverReport, changes: SemanticChange[]): void {
  const oldEnums = new Map(oldReport.enums.map((item) => [item.id, item]));
  const newEnums = new Map(newReport.enums.map((item) => [item.id, item]));

  for (const [id, item] of newEnums) {
    const previous = oldEnums.get(id);
    if (!previous) {
      changes.push({ type: 'enum_added', detail: `${id}: ${item.values.join(', ')}` });
      continue;
    }
    for (const value of item.values) {
      if (!previous.values.includes(value)) changes.push({ type: 'enum_value_added', detail: `${id} +${value}` });
    }
    for (const value of previous.values) {
      if (previous.confidence !== 'observed' && !item.values.includes(value)) {
        changes.push({ type: 'enum_value_removed', detail: `${id} -${value}` });
      }
    }
  }
  for (const [id, item] of oldEnums) {
    if (item.confidence !== 'observed' && !newEnums.has(id)) {
      changes.push({ type: 'enum_removed', detail: `${id}: ${item.values.join(', ')}` });
    }
  }
}

function isAppImpact(path: string, endpoint: EndpointReport): boolean {
  if (!endpoint.appDependency || !path || path === '$') return false;
  const normalized = path.replace(/\[\]/g, '').replace(/^\./, '');
  return endpoint.appDependency.fields.some((field) => (
    normalized === field || normalized.startsWith(`${field}.`) || field.startsWith(`${normalized}.`)
  ));
}

function errorConditionKey(error: StaticClientError): string {
  return JSON.stringify([error.status, error.errorCode, error.handler ?? null]);
}

function describeError(error: StaticClientError): string {
  return `${describeErrorCondition(error)}${error.clientMessage ? ` → ${error.clientMessage}` : ''}`;
}

function describeErrorCondition(error: StaticClientError): string {
  return [
    error.status === null ? null : `status=${error.status}`,
    error.errorCode ? `errorCode=${error.errorCode}` : null,
    error.handler ? `handler=${error.handler}` : null,
  ].filter(Boolean).join(', ') || 'generic';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
