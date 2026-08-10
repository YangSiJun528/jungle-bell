import { parseSync, visitorKeys } from 'oxc-parser';

import type {
  CollectedBundle,
  EnumCandidate,
  Evidence,
  HttpMethod,
  RequestContract,
  StaticClientError,
  StaticEndpoint,
  StaticExtraction,
} from './types.ts';

type AstNode = Record<string, any> & { type: string; start?: number; end?: number };
type WalkVisitor = (node: AstNode, ancestors: AstNode[]) => boolean | void;

const HTTP_METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);
const ENUM_VALUE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

interface ExtractOptions {
  relativeApiBasePath: string;
}

interface FunctionAnalysis {
  appendFields: string[];
  errors: StaticClientError[];
}

interface CallExtraction {
  method: HttpMethod;
  path: string;
  request: RequestContract;
  errors: StaticClientError[];
}

export function extractStaticContracts(bundles: CollectedBundle[], options: ExtractOptions): StaticExtraction {
  const endpoints = new Map<string, StaticEndpoint>();
  const enumCandidates: EnumCandidate[] = [];
  const warnings: string[] = [];

  for (const bundle of bundles) {
    let program: AstNode;
    try {
      const parsed = parseSync(bundle.name, bundle.code, {
        lang: 'js',
        sourceType: 'unambiguous',
        preserveParens: false,
      });
      program = parsed.program as unknown as AstNode;
      for (const error of parsed.errors.slice(0, 3)) {
        warnings.push(`${bundle.name}: ${error.message}`);
      }
    } catch (error) {
      warnings.push(`${bundle.name}: parse failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const functionCache = new Map<AstNode, FunctionAnalysis>();
    const comparisonEnums = new Map<string, { values: Set<string>; evidence: Evidence[] }>();

    walkAst(program, (node, ancestors) => {
      if (node.type === 'CallExpression') {
        const extraction = extractHttpCall(node, ancestors, options.relativeApiBasePath, functionCache, bundle);
        if (extraction) mergeEndpoint(endpoints, extraction, evidenceFor(bundle, node, 'http-call'));
      }

      if (node.type === 'ObjectExpression') {
        const values = objectEnumValues(node);
        if (values.length >= 2) {
          enumCandidates.push(makeEnumCandidate(values, inferNameHint(ancestors), null, 'high', evidenceFor(bundle, node, 'object-keys')));
        }
      }

      if (node.type === 'ArrayExpression') {
        const values = arrayEnumValues(node);
        if (values.length >= 2) {
          enumCandidates.push(makeEnumCandidate(values, inferNameHint(ancestors), null, 'high', evidenceFor(bundle, node, 'array-values')));
        }
      }

      if (node.type === 'SwitchStatement') {
        const values = sortedUnique((node.cases ?? [])
          .map((item: AstNode) => literalString(item.test))
          .filter((value: string | null): value is string => Boolean(value && ENUM_VALUE_RE.test(value))));
        if (values.length >= 2) {
          const field = lastMemberName(node.discriminant);
          enumCandidates.push(makeEnumCandidate(values, field, field, 'high', evidenceFor(bundle, node, 'switch-cases')));
        }
      }

      if (node.type === 'BinaryExpression' && ['===', '==', '!==', '!='].includes(node.operator)) {
        const comparison = enumComparison(node);
        if (comparison) {
          const group = comparisonEnums.get(comparison.field) ?? { values: new Set<string>(), evidence: [] };
          group.values.add(comparison.value);
          group.evidence.push(evidenceFor(bundle, node, 'comparison-values'));
          comparisonEnums.set(comparison.field, group);
        }
      }
    });

    for (const [field, group] of comparisonEnums) {
      const values = [...group.values].sort();
      if (values.length >= 2) {
        enumCandidates.push(makeEnumCandidate(values, field, field, 'medium', group.evidence[0]!, group.evidence.slice(1)));
      }
    }
  }

  const endpointEntries = [...endpoints.entries()].sort(([left], [right]) => left.localeCompare(right));
  const apiBundleHashes = new Set(endpointEntries.flatMap(([, endpoint]) => (
    endpoint.evidence.map((evidence) => evidence.sha256).filter((hash): hash is string => Boolean(hash))
  )));
  return {
    endpoints: Object.fromEntries(endpointEntries),
    enums: mergeEnumCandidates(enumCandidates).filter((candidate) => isRelevantEnumCandidate(candidate, apiBundleHashes)),
    warnings: sortedUnique(warnings),
  };
}

export function mergeEnumCandidates(candidates: EnumCandidate[]): EnumCandidate[] {
  const merged = new Map<string, EnumCandidate>();
  for (const candidate of candidates) {
    const key = candidate.name ?? (candidate.field ? `field:${candidate.field}` : candidate.id);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...candidate, values: [...candidate.values], evidence: [...candidate.evidence] });
      continue;
    }
    existing.values = sortedUnique([...existing.values, ...candidate.values]);
    existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
    existing.confidence = strongerConfidence(existing.confidence, candidate.confidence);
    existing.field ??= candidate.field;
    existing.name ??= candidate.name;
  }

  const coalesced: EnumCandidate[] = [];
  for (const candidate of merged.values()) {
    const equivalent = coalesced.find((item) => representsSameEnum(item, candidate));
    if (!equivalent) {
      coalesced.push(candidate);
      continue;
    }
    const preferred = enumIdentityRank(candidate) > enumIdentityRank(equivalent) ? candidate : equivalent;
    const other = preferred === candidate ? equivalent : candidate;
    Object.assign(equivalent, {
      id: preferred.id,
      name: preferred.name ?? other.name,
      field: preferred.field ?? other.field,
      values: sortedUnique([...preferred.values, ...other.values]),
      confidence: strongerConfidence(preferred.confidence, other.confidence),
      evidence: dedupeEvidence([...preferred.evidence, ...other.evidence]),
    });
  }
  return coalesced.sort((left, right) => left.id.localeCompare(right.id));
}

function extractHttpCall(
  node: AstNode,
  ancestors: AstNode[],
  relativeApiBasePath: string,
  functionCache: Map<AstNode, FunctionAnalysis>,
  bundle: CollectedBundle,
): CallExtraction | null {
  const callee = unwrapChain(node.callee);
  let method: HttpMethod | null = null;
  let urlNode: AstNode | null = null;
  let queryConfig: AstNode | null = null;
  let bodyNode: AstNode | null = null;
  let headersConfig: AstNode | null = null;

  if (callee?.type === 'Identifier' && callee.name === 'fetch') {
    method = methodFromFetchOptions(node.arguments?.[1]) ?? 'GET';
    urlNode = unwrapArgument(node.arguments?.[0]);
    const options = unwrapArgument(node.arguments?.[1]);
    bodyNode = objectProperty(options, 'body');
    headersConfig = options;
  } else if (callee?.type === 'MemberExpression') {
    const property = propertyName(callee);
    if (property && HTTP_METHODS.has(property)) {
      method = property.toUpperCase() as HttpMethod;
      urlNode = unwrapArgument(node.arguments?.[0]);
      if (method === 'GET' || method === 'DELETE') {
        queryConfig = unwrapArgument(node.arguments?.[1]);
        headersConfig = queryConfig;
      } else {
        bodyNode = unwrapArgument(node.arguments?.[1]);
        headersConfig = unwrapArgument(node.arguments?.[2]);
      }
    } else if (property === 'request') {
      const config = unwrapArgument(node.arguments?.[0]);
      method = methodFromRequestConfig(config);
      urlNode = objectProperty(config, 'url');
      queryConfig = config;
      bodyNode = objectProperty(config, 'data') ?? objectProperty(config, 'body');
      headersConfig = config;
    }
  }

  if (!method || !urlNode) return null;
  const rawPath = stringExpressionToPath(urlNode);
  if (!rawPath) return null;
  const path = normalizeApiPath(rawPath, relativeApiBasePath);
  if (!path) return null;

  const enclosingFunction = [...ancestors].reverse().find(isFunctionNode);
  let functionAnalysis: FunctionAnalysis = { appendFields: [], errors: [] };
  if (enclosingFunction) {
    functionAnalysis = functionCache.get(enclosingFunction) ?? analyzeFunction(enclosingFunction, bundle);
    functionCache.set(enclosingFunction, functionAnalysis);
  }

  const queryParams = extractQueryParams(queryConfig);
  const bodyFields = sortedUnique([
    ...objectKeys(unwrapBodyExpression(bodyNode)),
    ...functionAnalysis.appendFields,
  ]);
  const contentTypes = extractContentTypes(headersConfig);

  return {
    method,
    path,
    request: {
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!),
      queryParams,
      bodyFields,
      contentTypes,
    },
    errors: functionAnalysis.errors,
  };
}

function mergeEndpoint(endpoints: Map<string, StaticEndpoint>, extraction: CallExtraction, evidence: Evidence): void {
  const signature = `${extraction.method} ${extraction.path}`;
  const existing = endpoints.get(signature);
  if (!existing) {
    endpoints.set(signature, {
      method: extraction.method,
      path: extraction.path,
      request: extraction.request,
      errors: extraction.errors,
      evidence: [evidence],
    });
    return;
  }

  existing.request.pathParams = sortedUnique([...existing.request.pathParams, ...extraction.request.pathParams]);
  existing.request.bodyFields = sortedUnique([...existing.request.bodyFields, ...extraction.request.bodyFields]);
  existing.request.contentTypes = sortedUnique([...existing.request.contentTypes, ...extraction.request.contentTypes]);
  existing.request.queryParams = { ...existing.request.queryParams, ...extraction.request.queryParams };
  existing.errors = dedupeErrors([...existing.errors, ...extraction.errors]);
  existing.evidence = dedupeEvidence([...existing.evidence, evidence]).slice(0, 10);
}

function analyzeFunction(node: AstNode, bundle: CollectedBundle): FunctionAnalysis {
  const appendFields = new Set<string>();
  const errors: StaticClientError[] = [];

  walkAst(node, (child, ancestors) => {
    if (child !== node && isFunctionNode(child)) return false;

    if (child.type === 'CallExpression' && propertyName(unwrapChain(child.callee)) === 'append') {
      const field = literalString(unwrapArgument(child.arguments?.[0]));
      if (field) appendFields.add(field);
    }

    if (child.type === 'IfStatement') {
      const condition = extractErrorCondition(child.test);
      const messages = extractClientMessages(child.consequent);
      if (condition.status !== null || condition.errorCode !== null || messages.length > 0) {
        for (const message of messages.length > 0 ? messages : [{ clientMessage: null, handler: null }]) {
          errors.push({
            source: 'static-client',
            status: condition.status,
            errorCode: condition.errorCode,
            clientMessage: message.clientMessage,
            handler: message.handler,
          });
        }
      }
    }

    // Avoid collecting a parent IfStatement's nested branch as its own message.
    if (ancestors.at(-1)?.type === 'IfStatement' && child.type === 'IfStatement') return false;
  });

  return { appendFields: [...appendFields].sort(), errors: dedupeErrors(errors) };
}

function evidenceFor(bundle: CollectedBundle, node: AstNode, kind: Evidence['kind']): Evidence {
  const start = node.start ?? 0;
  const end = node.end ?? start;
  const evidence: Evidence = {
    kind,
    bundle: bundle.name,
    bundleUrl: bundle.url,
    sha256: bundle.sha256,
    start,
    end,
    snippet: compactSnippet(bundle.code.slice(start, Math.min(end, start + 500))),
  };
  return evidence;
}

function extractErrorCondition(node: AstNode): { status: number | null; errorCode: string | null } {
  let status: number | null = null;
  let errorCode: string | null = null;
  walkAst(node, (child) => {
    if (child.type !== 'BinaryExpression' || !['===', '=='].includes(child.operator)) return;
    const pairs: Array<[AstNode | null, AstNode | null]> = [
      [unwrapChain(child.left), unwrapChain(child.right)],
      [unwrapChain(child.right), unwrapChain(child.left)],
    ];
    for (const [member, literal] of pairs) {
      const path = memberPath(member).toLowerCase();
      const value = literalValue(literal);
      if (path.endsWith('.status') && typeof value === 'number') status = value;
      if ((path.endsWith('.errorcode') || path.endsWith('.code')) && typeof value === 'string') errorCode = value;
    }
  });
  return { status, errorCode };
}

function extractClientMessages(node: AstNode): Array<{ clientMessage: string | null; handler: string | null }> {
  const results: Array<{ clientMessage: string | null; handler: string | null }> = [];
  walkAst(node, (child) => {
    if (child !== node && child.type === 'IfStatement') return false;
    if (child.type !== 'ThrowStatement') return;
    const argument = unwrapChain(child.argument);
    if (!argument || !['CallExpression', 'NewExpression'].includes(argument.type)) return;
    const callee = unwrapChain(argument.callee);
    const name = callee?.type === 'Identifier' ? callee.name : propertyName(callee);
    if (name !== 'Error') return;
    const first = unwrapArgument(argument.arguments?.[0]);
    const clientMessage = literalString(first);
    const handler = clientMessage ? null : calledFunctionName(first);
    results.push({ clientMessage, handler });
  });
  return results;
}

function extractQueryParams(config: AstNode | null): RequestContract['queryParams'] {
  const params = objectProperty(config, 'params');
  if (!params || params.type !== 'ObjectExpression') return {};
  const result: RequestContract['queryParams'] = {};
  for (const property of params.properties ?? []) {
    if (property.type !== 'Property') continue;
    const key = keyName(property.key);
    if (!key) continue;
    const defaultValue = nullishDefault(property.value);
    result[key] = defaultValue === undefined ? {} : { default: defaultValue };
  }
  return result;
}

function extractContentTypes(config: AstNode | null): string[] {
  const headers = objectProperty(config, 'headers') ?? config;
  if (!headers || headers.type !== 'ObjectExpression') return [];
  const values: string[] = [];
  for (const property of headers.properties ?? []) {
    if (property.type !== 'Property') continue;
    const key = keyName(property.key)?.toLowerCase();
    if (key !== 'content-type') continue;
    const value = literalString(property.value);
    if (value) values.push(value);
  }
  return sortedUnique(values);
}

function methodFromFetchOptions(options: AstNode | null): HttpMethod | null {
  const method = literalString(objectProperty(unwrapArgument(options), 'method'))?.toUpperCase();
  return isHttpMethod(method) ? method : null;
}

function methodFromRequestConfig(config: AstNode | null): HttpMethod | null {
  const method = literalString(objectProperty(config, 'method'))?.toUpperCase();
  return isHttpMethod(method) ? method : null;
}

function unwrapBodyExpression(node: AstNode | null): AstNode | null {
  if (!node) return null;
  if (node.type === 'CallExpression' && calledFunctionName(node) === 'stringify') return unwrapArgument(node.arguments?.[0]);
  return node;
}

function normalizeApiPath(raw: string, relativeApiBasePath: string): string | null {
  let path = raw.trim();
  if (/^https?:\/\//.test(path)) path = path.replace(/^https?:\/\/[^/]+/, '');
  path = path.split('?')[0] ?? path;
  if (!path.startsWith('/')) return null;
  if (path.startsWith('/api/')) return path;
  if (path.startsWith('/me/') || path === '/me' || path.startsWith('/auth/')) {
    return `${relativeApiBasePath.replace(/\/$/, '')}${path}`;
  }
  return null;
}

function stringExpressionToPath(node: AstNode): string | null {
  const parts = stringParts(unwrapChain(node));
  if (!parts || !parts.some((part) => typeof part === 'string' && part.length > 0)) return null;
  let result = '';
  let placeholderIndex = 0;
  for (const part of parts) {
    if (part !== null) {
      result += part;
      continue;
    }
    result += `{${inferPlaceholderName(result, placeholderIndex++)}}`;
  }
  return result;
}

function stringParts(node: AstNode | null): Array<string | null> | null {
  if (!node) return null;
  const literal = literalString(node);
  if (literal !== null) return [literal];
  if (node.type === 'TemplateLiteral') {
    const parts: Array<string | null> = [];
    for (let index = 0; index < (node.quasis?.length ?? 0); index++) {
      parts.push(node.quasis[index]?.value?.cooked ?? node.quasis[index]?.value?.raw ?? '');
      if (index < (node.expressions?.length ?? 0)) parts.push(null);
    }
    return parts;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = stringParts(unwrapChain(node.left));
    const right = stringParts(unwrapChain(node.right));
    if (!left && !right) return null;
    return [...(left ?? [null]), ...(right ?? [null])];
  }
  return [null];
}

function inferPlaceholderName(prefix: string, index: number): string {
  const segment = prefix.split('/').filter(Boolean).at(-1)?.replace(/\{[^}]+\}/g, '') ?? '';
  const singular = singularize(segment);
  if (!singular || singular === 'api' || /^v\d+$/.test(singular)) return `param${index + 1}`;
  const camel = singular.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return camel.endsWith('Id') ? camel : `${camel}Id`;
}

function singularize(value: string): string {
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ses')) return value.slice(0, -2);
  if (value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function objectEnumValues(node: AstNode): string[] {
  if (node.type !== 'ObjectExpression') return [];
  return sortedUnique((node.properties ?? [])
    .filter((property: AstNode) => property.type === 'Property')
    .map((property: AstNode) => keyName(property.key))
    .filter((value: string | null): value is string => Boolean(value && ENUM_VALUE_RE.test(value))));
}

function arrayEnumValues(node: AstNode): string[] {
  if (node.type !== 'ArrayExpression') return [];
  return sortedUnique((node.elements ?? [])
    .map((element: AstNode) => literalString(unwrapArgument(element)))
    .filter((value: string | null): value is string => Boolean(value && ENUM_VALUE_RE.test(value))));
}

function enumComparison(node: AstNode): { field: string; value: string } | null {
  for (const [member, literal] of [[node.left, node.right], [node.right, node.left]] as Array<[AstNode, AstNode]>) {
    const value = literalString(unwrapChain(literal));
    const field = lastMemberName(unwrapChain(member));
    if (value && field && ENUM_VALUE_RE.test(value)) return { field, value };
  }
  return null;
}

function makeEnumCandidate(
  values: string[],
  hint: string | null,
  field: string | null,
  confidence: EnumCandidate['confidence'],
  evidence: Evidence,
  additionalEvidence: Evidence[] = [],
): EnumCandidate {
  const identity = inferEnumIdentity(values, hint, field);
  return {
    id: identity.name ?? (identity.field ? `field:${identity.field}` : `enum:${values[0]!.toLowerCase()}`),
    name: identity.name,
    field: identity.field,
    values: sortedUnique(values),
    confidence,
    evidence: dedupeEvidence([evidence, ...additionalEvidence]),
  };
}

function inferEnumIdentity(values: string[], hint: string | null, field: string | null): { name: string | null; field: string | null } {
  if (values.some((value) => ['PRESENT', 'ABSENT', 'LATE', 'SELF_STUDY'].includes(value))) {
    return { name: 'attendance_status', field: 'status' };
  }
  if (values.some((value) => ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'].includes(value))) {
    return { name: 'leave_request_status', field: 'status' };
  }
  if (values.some((value) => ['BIRTH', 'DEATH', 'ILLNESS', 'MARRIAGE'].includes(value))) {
    return { name: 'official_leave_category', field: 'category' };
  }
  if (values.some((value) => ['CHILD', 'GRANDPARENT', 'PARENT', 'SIBLING', 'SPOUSE'].includes(value))) {
    return { name: 'official_leave_target', field: 'target' };
  }
  const usableHint = hint && hint.length > 2 ? toSnakeCase(hint).replace(/_(labels?|map)$/, '') : null;
  return { name: usableHint, field: field ?? (usableHint?.endsWith('_status') ? 'status' : null) };
}

function isRelevantEnumCandidate(candidate: EnumCandidate, apiBundleHashes: Set<string>): boolean {
  const knownDomainEnum = ['attendance_status', 'leave_request_status'].includes(candidate.name ?? '');
  const comesFromApiBundle = candidate.evidence.some((evidence) => (
    Boolean(evidence.sha256) && apiBundleHashes.has(evidence.sha256!)
  ));
  if (!knownDomainEnum && !comesFromApiBundle) return false;

  // Two-character tokens in minified dependencies are overwhelmingly property aliases,
  // date-format tokens, or generated identifiers rather than domain values.
  const onlyMinifiedTokens = candidate.values.every((value) => value.length <= 2 || /^[A-Z]\d$/.test(value));
  return knownDomainEnum || !onlyMinifiedTokens;
}

function representsSameEnum(left: EnumCandidate, right: EnumCandidate): boolean {
  if (left.name && right.name) return left.name === right.name;
  if (left.field && right.field && left.field !== right.field) return false;
  const overlap = left.values.filter((value) => right.values.includes(value)).length;
  return overlap >= 2 && overlap === Math.min(left.values.length, right.values.length);
}

function enumIdentityRank(candidate: EnumCandidate): number {
  if (candidate.name) return 3;
  if (candidate.field) return 2;
  return 1;
}

function inferNameHint(ancestors: AstNode[]): string | null {
  const parent = ancestors.at(-1);
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator') return keyName(parent.id);
  if (parent.type === 'Property') return keyName(parent.key);
  return null;
}

function objectProperty(node: AstNode | null, target: string): AstNode | null {
  const value = unwrapChain(node);
  if (!value || value.type !== 'ObjectExpression') return null;
  for (const property of value.properties ?? []) {
    if (property.type === 'Property' && keyName(property.key) === target) return unwrapChain(property.value);
  }
  return null;
}

function objectKeys(node: AstNode | null): string[] {
  if (!node || node.type !== 'ObjectExpression') return [];
  return sortedUnique((node.properties ?? [])
    .filter((property: AstNode) => property.type === 'Property')
    .map((property: AstNode) => keyName(property.key))
    .filter((value: string | null): value is string => Boolean(value)));
}

function nullishDefault(node: AstNode): string | number | boolean | null | undefined {
  const value = unwrapChain(node);
  if (value?.type === 'LogicalExpression' && value.operator === '??') {
    const literal = literalValue(unwrapChain(value.right));
    return ['string', 'number', 'boolean'].includes(typeof literal) || literal === null
      ? literal as string | number | boolean | null
      : undefined;
  }
  return undefined;
}

function literalString(node: AstNode | null): string | null {
  const value = literalValue(node);
  return typeof value === 'string' ? value : null;
}

function literalValue(node: AstNode | null): unknown {
  const value = unwrapChain(node);
  return value?.type === 'Literal' ? value.value : undefined;
}

function propertyName(node: AstNode | null): string | null {
  const value = unwrapChain(node);
  if (!value || value.type !== 'MemberExpression') return null;
  return keyName(value.property);
}

function lastMemberName(node: AstNode | null): string | null {
  const value = unwrapChain(node);
  return value?.type === 'MemberExpression' ? propertyName(value) : null;
}

function memberPath(node: AstNode | null): string {
  const value = unwrapChain(node);
  if (!value) return '';
  if (value.type === 'Identifier') return value.name;
  if (value.type === 'MemberExpression') {
    const left = memberPath(value.object);
    const right = propertyName(value);
    return [left, right].filter(Boolean).join('.');
  }
  return '';
}

function calledFunctionName(node: AstNode | null): string | null {
  const value = unwrapChain(node);
  if (!value || value.type !== 'CallExpression') return null;
  const callee = unwrapChain(value.callee);
  if (callee?.type === 'Identifier') return callee.name;
  return propertyName(callee);
}

function keyName(node: AstNode | null): string | null {
  const value = unwrapChain(node);
  if (!value) return null;
  if (value.type === 'Identifier') return value.name;
  return literalString(value);
}

function unwrapArgument(node: AstNode | null | undefined): AstNode | null {
  if (!node || node.type === 'SpreadElement') return null;
  return unwrapChain(node);
}

function unwrapChain(node: AstNode | null | undefined): AstNode | null {
  let value = node ?? null;
  while (value && ['ChainExpression', 'ParenthesizedExpression', 'TSAsExpression'].includes(value.type)) {
    value = value.expression ?? null;
  }
  return value;
}

function isFunctionNode(node: AstNode): boolean {
  return ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(node.type);
}

function isHttpMethod(value: string | undefined): value is HttpMethod {
  return value !== undefined && ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(value);
}

function walkAst(node: AstNode | null, visitor: WalkVisitor, ancestors: AstNode[] = []): void {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (visitor(node, ancestors) === false) return;
  const keys = visitorKeys[node.type] ?? [];
  const nextAncestors = [...ancestors, node];
  for (const key of keys) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item as AstNode, visitor, nextAncestors);
    } else {
      walkAst(child as AstNode, visitor, nextAncestors);
    }
  }
}

function dedupeErrors(errors: StaticClientError[]): StaticClientError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = JSON.stringify([error.status, error.errorCode, error.clientMessage, error.handler ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify([item.kind, item.sha256, item.start, item.end, item.endpoint, item.status]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function strongerConfidence(left: EnumCandidate['confidence'], right: EnumCandidate['confidence']): EnumCandidate['confidence'] {
  const rank = { observed: 0, medium: 1, high: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function compactSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}
