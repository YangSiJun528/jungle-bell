export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type EndpointSource = 'static' | 'runtime' | 'app-dependency';
export type SchemaType = 'array' | 'boolean' | 'empty' | 'null' | 'number' | 'object' | 'string' | 'unknown';

export interface CollectedBundle {
  name: string;
  url: string;
  sha256: string;
  code: string;
}

export interface CapturedExchange {
  method: string;
  url: string;
  status: number;
  requestContentType: string | null;
  requestBody: unknown;
  responseContentType: string | null;
  responseBody: unknown;
}

export interface CollectionResult {
  visitedRoutes: string[];
  bundles: CollectedBundle[];
  exchanges: CapturedExchange[];
}

export interface ObserverConfig {
  baseUrl: string;
  entryPath: string;
  routes: string[];
  relativeApiBasePath: string;
  apiPathPrefixes: string[];
  appDependencies: Record<string, string[]>;
}

export interface Evidence {
  kind: 'array-values' | 'comparison-values' | 'object-keys' | 'runtime-observed' | 'switch-cases' | 'http-call';
  bundle?: string;
  bundleUrl?: string;
  sha256?: string;
  start?: number;
  end?: number;
  snippet?: string;
  endpoint?: string;
  status?: number;
}

export interface RequestContract {
  pathParams: string[];
  queryParams: Record<string, { default?: string | number | boolean | null }>;
  bodyFields: string[];
  contentTypes: string[];
}

export interface StaticClientError {
  source: 'static-client';
  status: number | null;
  errorCode: string | null;
  clientMessage: string | null;
  handler?: string | null;
}

export interface StaticEndpoint {
  method: HttpMethod;
  path: string;
  request: RequestContract;
  errors: StaticClientError[];
  evidence: Evidence[];
}

export interface EnumCandidate {
  id: string;
  name: string | null;
  field: string | null;
  values: string[];
  confidence: 'high' | 'medium' | 'observed';
  evidence: Evidence[];
}

export interface StaticExtraction {
  endpoints: Record<string, StaticEndpoint>;
  enums: EnumCandidate[];
  warnings: string[];
}

export interface SchemaNode {
  types: SchemaType[];
  sampleCount: number;
  presence?: 'optional' | 'required';
  format?: 'date' | 'date-time';
  enumCandidates?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

export interface ObservedError {
  source: 'runtime-response';
  status: number;
  schema: SchemaNode;
  errorCodes: string[];
  messages: string[];
}

export interface EndpointReport {
  method: HttpMethod;
  path: string;
  sources: EndpointSource[];
  request: RequestContract;
  responses: Record<string, SchemaNode>;
  errors: StaticClientError[];
  observedErrors: ObservedError[];
  evidence: Evidence[];
  appDependency?: { fields: string[] };
}

export interface ObserverReport {
  schemaVersion: 1;
  generatedAt: string;
  target: {
    baseUrl: string;
    visitedRoutes: string[];
    bundleCount: number;
    bundles: Array<{ name: string; url: string; sha256: string }>;
  };
  endpoints: Record<string, EndpointReport>;
  enums: EnumCandidate[];
  warnings: string[];
}

export type ChangeType =
  | 'api_added'
  | 'api_removed'
  | 'client_error_added'
  | 'client_error_removed'
  | 'client_message_changed'
  | 'enum_added'
  | 'enum_removed'
  | 'enum_value_added'
  | 'enum_value_removed'
  | 'observed_error_code_added'
  | 'observed_error_code_removed'
  | 'observed_error_message_added'
  | 'observed_error_message_removed'
  | 'request_changed'
  | 'response_field_added'
  | 'response_field_removed'
  | 'response_status_added'
  | 'response_status_removed'
  | 'response_type_changed';

export interface SemanticChange {
  type: ChangeType;
  detail: string;
  endpoint?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  appImpact?: boolean;
}

export interface DiffResult {
  firstRun: boolean;
  hasChanges: boolean;
  changes: SemanticChange[];
}
