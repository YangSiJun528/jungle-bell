import { extractObservedErrorMetadata, inferSchemaFromSamples } from './schema.ts';
import { mergeEnumCandidates } from './static-extractor.ts';
import type {
  CapturedExchange,
  CollectionResult,
  EndpointReport,
  EnumCandidate,
  HttpMethod,
  ObserverConfig,
  ObserverReport,
  RequestContract,
  SchemaNode,
  StaticExtraction,
} from './types.ts';

interface BuildReportInput {
  config: ObserverConfig;
  staticResult: StaticExtraction;
  collection: CollectionResult;
}

export function buildObserverReport({ config, staticResult, collection }: BuildReportInput): ObserverReport {
  const endpoints = new Map<string, EndpointReport>();
  const responseSamples = new Map<string, Map<number, unknown[]>>();
  const observedErrorValues = new Map<string, Map<number, unknown[]>>();

  for (const [signature, endpoint] of Object.entries(staticResult.endpoints)) {
    endpoints.set(signature, {
      method: endpoint.method,
      path: endpoint.path,
      sources: ['static'],
      request: cloneRequest(endpoint.request),
      responses: {},
      errors: endpoint.errors.map((error) => ({ ...error })),
      observedErrors: [],
      evidence: endpoint.evidence.map((evidence) => ({ ...evidence })),
    });
  }

  for (const [signature, fields] of Object.entries(config.appDependencies)) {
    const parsed = parseSignature(signature);
    if (!parsed) continue;
    const endpoint = endpoints.get(signature) ?? emptyEndpoint(parsed.method, parsed.path);
    addSource(endpoint, 'app-dependency');
    endpoint.appDependency = { fields: [...fields].sort() };
    endpoints.set(signature, endpoint);
  }

  for (const exchange of collection.exchanges) {
    const runtime = runtimeSignature(exchange, endpoints, config);
    if (!runtime) continue;
    const endpoint = endpoints.get(runtime.signature) ?? emptyEndpoint(runtime.method, runtime.path);
    addSource(endpoint, 'runtime');
    mergeRuntimeRequest(endpoint.request, exchange);
    endpoints.set(runtime.signature, endpoint);

    const statuses = responseSamples.get(runtime.signature) ?? new Map<number, unknown[]>();
    const samples = statuses.get(exchange.status) ?? [];
    samples.push(exchange.responseBody);
    statuses.set(exchange.status, samples);
    responseSamples.set(runtime.signature, statuses);

    if (exchange.status >= 400) {
      const errors = observedErrorValues.get(runtime.signature) ?? new Map<number, unknown[]>();
      const values = errors.get(exchange.status) ?? [];
      values.push(exchange.responseBody);
      errors.set(exchange.status, values);
      observedErrorValues.set(runtime.signature, errors);
    }
  }

  const runtimeEnums: EnumCandidate[] = [];
  for (const [signature, statuses] of responseSamples) {
    const endpoint = endpoints.get(signature)!;
    for (const [status, samples] of statuses) {
      const schema = inferSchemaFromSamples(samples);
      endpoint.responses[String(status)] = schema;
      runtimeEnums.push(...enumCandidatesFromSchema(schema, signature, status));
    }
    endpoint.responses = Object.fromEntries(Object.entries(endpoint.responses).sort(([left], [right]) => Number(left) - Number(right)));
  }

  for (const [signature, statuses] of observedErrorValues) {
    const endpoint = endpoints.get(signature)!;
    for (const [status, samples] of statuses) {
      const metadata = samples.map(extractObservedErrorMetadata);
      endpoint.observedErrors.push({
        source: 'runtime-response',
        status,
        schema: inferSchemaFromSamples(samples),
        errorCodes: sortedUnique(metadata.flatMap((item) => item.errorCodes)),
        messages: sortedUnique(metadata.flatMap((item) => item.messages)),
      });
    }
    endpoint.observedErrors.sort((left, right) => left.status - right.status);
  }

  const warnings = [...staticResult.warnings];
  if (collection.bundles.length > 0 && Object.keys(staticResult.endpoints).length === 0) {
    warnings.push('현재 실행의 번들에서 API 엔드포인트를 찾지 못했습니다. 추출 규칙 변경이 필요할 수 있습니다.');
  }
  if (collection.exchanges.length === 0) {
    warnings.push('현재 실행에서 API 응답을 관찰하지 못했습니다. 응답 스키마는 정적 정보만 포함합니다.');
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      baseUrl: config.baseUrl,
      visitedRoutes: [...collection.visitedRoutes],
      bundleCount: collection.bundles.length,
      bundles: collection.bundles
        .map(({ name, url, sha256 }) => ({ name, url, sha256 }))
        .sort((left, right) => left.url.localeCompare(right.url)),
    },
    endpoints: Object.fromEntries([...endpoints.entries()].sort(([left], [right]) => left.localeCompare(right))),
    enums: mergeEnumCandidates([...staticResult.enums, ...runtimeEnums]),
    warnings: sortedUnique(warnings),
  };
}

function runtimeSignature(
  exchange: CapturedExchange,
  endpoints: Map<string, EndpointReport>,
  config: ObserverConfig,
): { signature: string; method: HttpMethod; path: string } | null {
  if (!isHttpMethod(exchange.method.toUpperCase())) return null;
  const method = exchange.method.toUpperCase() as HttpMethod;
  let url: URL;
  try {
    url = new URL(exchange.url);
  } catch {
    return null;
  }
  if (!config.apiPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return null;

  const matching = [...endpoints.entries()]
    .filter(([, endpoint]) => endpoint.method === method && templateMatches(endpoint.path, url.pathname))
    .sort((left, right) => right[1].path.length - left[1].path.length)[0];
  if (matching) return { signature: matching[0], method, path: matching[1].path };

  const path = sanitizeRuntimePath(url.pathname);
  return { signature: `${method} ${path}`, method, path };
}

function templateMatches(template: string, actual: string): boolean {
  const pattern = template
    .split('/')
    .map((segment) => /^\{[^}]+\}$/.test(segment) ? '[^/]+' : escapeRegExp(segment))
    .join('/');
  return new RegExp(`^${pattern}$`).test(actual);
}

function sanitizeRuntimePath(path: string): string {
  return path.split('/').map((segment) => {
    if (/^c[a-z0-9]{20,}$/i.test(segment)) return '{id}';
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return '{id}';
    if (/^\d{4,}$/.test(segment)) return '{id}';
    return segment;
  }).join('/');
}

function mergeRuntimeRequest(request: RequestContract, exchange: CapturedExchange): void {
  const url = new URL(exchange.url);
  for (const key of url.searchParams.keys()) request.queryParams[key] ??= {};
  if (exchange.requestContentType) request.contentTypes = sortedUnique([...request.contentTypes, exchange.requestContentType]);
  request.bodyFields = sortedUnique([...request.bodyFields, ...requestBodyFields(exchange.requestBody)]);
}

function requestBodyFields(value: unknown): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).sort();
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed).sort();
  } catch {
    return sortedUnique([...new URLSearchParams(value).keys()]);
  }
  return [];
}

function enumCandidatesFromSchema(schema: SchemaNode, endpoint: string, status: number, path = ''): EnumCandidate[] {
  const candidates: EnumCandidate[] = [];
  if ((schema.enumCandidates?.length ?? 0) >= 2) {
    const field = path.split('.').filter(Boolean).at(-1)?.replace(/\[\]$/, '') ?? null;
    const values = schema.enumCandidates!;
    const name = knownEnumName(values);
    candidates.push({
      id: name ?? (field ? `field:${field}` : `runtime:${values[0]!.toLowerCase()}`),
      name,
      field,
      values: [...values],
      confidence: 'observed',
      evidence: [{ kind: 'runtime-observed', endpoint, status }],
    });
  }
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      candidates.push(...enumCandidatesFromSchema(value, endpoint, status, path ? `${path}.${key}` : key));
    }
  }
  if (schema.items) candidates.push(...enumCandidatesFromSchema(schema.items, endpoint, status, `${path}[]`));
  return candidates;
}

function knownEnumName(values: string[]): string | null {
  if (values.some((value) => ['PRESENT', 'ABSENT', 'LATE', 'SELF_STUDY'].includes(value))) return 'attendance_status';
  if (values.some((value) => ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'].includes(value))) return 'leave_request_status';
  if (values.some((value) => ['BIRTH', 'DEATH', 'ILLNESS', 'MARRIAGE'].includes(value))) return 'official_leave_category';
  if (values.some((value) => ['CHILD', 'GRANDPARENT', 'PARENT', 'SIBLING', 'SPOUSE'].includes(value))) return 'official_leave_target';
  return null;
}

function emptyEndpoint(method: HttpMethod, path: string): EndpointReport {
  return {
    method,
    path,
    sources: [],
    request: { pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!), queryParams: {}, bodyFields: [], contentTypes: [] },
    responses: {},
    errors: [],
    observedErrors: [],
    evidence: [],
  };
}

function cloneRequest(request: RequestContract): RequestContract {
  return {
    pathParams: [...request.pathParams],
    queryParams: Object.fromEntries(Object.entries(request.queryParams).map(([key, value]) => [key, { ...value }])),
    bodyFields: [...request.bodyFields],
    contentTypes: [...request.contentTypes],
  };
}

function parseSignature(signature: string): { method: HttpMethod; path: string } | null {
  const separator = signature.indexOf(' ');
  if (separator < 0) return null;
  const method = signature.slice(0, separator);
  const path = signature.slice(separator + 1);
  return isHttpMethod(method) && path.startsWith('/') ? { method, path } : null;
}

function addSource(endpoint: EndpointReport, source: EndpointReport['sources'][number]): void {
  if (!endpoint.sources.includes(source)) endpoint.sources.push(source);
  const order: EndpointReport['sources'][number][] = ['static', 'runtime', 'app-dependency'];
  endpoint.sources.sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function isHttpMethod(value: string): value is HttpMethod {
  return ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}
