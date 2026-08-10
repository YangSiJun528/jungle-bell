import assert from 'node:assert/strict';
import test from 'node:test';

import { diffReports } from '../lib/differ.ts';
import { buildObserverReport } from '../lib/report.ts';
import type { ObserverConfig, ObserverReport, SchemaType, StaticExtraction } from '../lib/types.ts';

const config: ObserverConfig = {
  baseUrl: 'https://jungle-lms.krafton.com',
  entryPath: '/check-in',
  routes: ['/check-in'],
  relativeApiBasePath: '/api/v2',
  apiPathPrefixes: ['/api/'],
  appDependencies: {
    'GET /api/v2/me/cohorts/{cohortId}/attendance/today': ['checkedAt', 'checkedOutAt'],
  },
};

test('런타임 URL을 정적 템플릿에 병합하고 앱 의존 필드를 표시한다', () => {
  const staticResult: StaticExtraction = {
    endpoints: {
      'GET /api/v2/me/cohorts/{cohortId}/attendance/today': {
        method: 'GET',
        path: '/api/v2/me/cohorts/{cohortId}/attendance/today',
        request: { pathParams: ['cohortId'], queryParams: {}, bodyFields: [], contentTypes: [] },
        errors: [],
        evidence: [],
      },
    },
    enums: [],
    warnings: [],
  };

  const report = buildObserverReport({
    config,
    staticResult,
    collection: {
      visitedRoutes: ['/check-in'],
      bundles: [],
      exchanges: [{
        method: 'GET',
        url: 'https://jungle-lms.krafton.com/api/v2/me/cohorts/c12345678901234567890/attendance/today',
        status: 200,
        requestContentType: null,
        requestBody: null,
        responseContentType: 'application/json',
        responseBody: { checkedAt: null, checkedOutAt: null, isStudying: false },
      }],
    },
  });

  const endpoint = report.endpoints['GET /api/v2/me/cohorts/{cohortId}/attendance/today'];
  assert.ok(endpoint);
  assert.deepEqual(endpoint.appDependency?.fields, ['checkedAt', 'checkedOutAt']);
  assert.deepEqual(endpoint.responses['200']?.properties?.isStudying?.types, ['boolean']);
  assert.ok(endpoint.sources.includes('runtime'));
});

test('응답 필드·ENUM·클라이언트 오류 변경을 의미 기반으로 분류한다', () => {
  const oldReport = reportFixture(['null', 'string'], ['ABSENT', 'PRESENT'], '기존 메시지');
  const newReport = reportFixture(['null', 'object'], ['ABSENT', 'LATE', 'PRESENT'], '변경 메시지');

  const result = diffReports(oldReport, newReport);

  assert.ok(result.changes.some((change) => (
    change.type === 'response_type_changed'
    && change.field === 'checkedOutAt'
    && change.appImpact === true
  )));
  assert.ok(result.changes.some((change) => change.type === 'enum_value_added' && change.detail.includes('LATE')));
  assert.ok(result.changes.some((change) => change.type === 'client_message_changed'));
});

test('실제 오류 응답의 코드와 익명화된 메시지 변경을 분류한다', () => {
  const oldReport = reportFixture(['null'], [], '동일');
  const newReport = reportFixture(['null'], [], '동일');
  const signature = 'GET /api/v2/me/cohorts/{cohortId}/attendance/today';
  oldReport.endpoints[signature]!.observedErrors = [{
    source: 'runtime-response',
    status: 403,
    schema: { types: ['object'], sampleCount: 1 },
    errorCodes: ['OLD_CODE'],
    messages: ['기존 오류'],
  }];
  newReport.endpoints[signature]!.observedErrors = [{
    source: 'runtime-response',
    status: 403,
    schema: { types: ['object'], sampleCount: 1 },
    errorCodes: ['NEW_CODE'],
    messages: ['변경 오류'],
  }];

  const result = diffReports(oldReport, newReport);

  assert.ok(result.changes.some((change) => change.type === 'observed_error_code_added'));
  assert.ok(result.changes.some((change) => change.type === 'observed_error_code_removed'));
  assert.ok(result.changes.some((change) => change.type === 'observed_error_message_added'));
  assert.ok(result.changes.some((change) => change.type === 'observed_error_message_removed'));
});

test('배열 응답에서 앱 의존 필드가 사라져도 영향도를 표시한다', () => {
  const oldReport = reportFixture(['null'], [], '동일');
  const newReport = reportFixture(['null'], [], '동일');
  const signature = 'GET /api/v2/me/cohorts/{cohortId}/attendance/today';
  const oldEndpoint = oldReport.endpoints[signature]!;
  const newEndpoint = newReport.endpoints[signature]!;
  oldEndpoint.responses['200'] = {
    types: ['array'],
    sampleCount: 1,
    items: {
      types: ['object'],
      sampleCount: 1,
      properties: { checkedOutAt: { types: ['string'], sampleCount: 1 } },
    },
  };
  newEndpoint.responses['200'] = {
    types: ['array'],
    sampleCount: 1,
    items: { types: ['object'], sampleCount: 1, properties: {} },
  };

  const result = diffReports(oldReport, newReport);

  assert.ok(result.changes.some((change) => (
    change.type === 'response_field_removed'
    && change.field === '[].checkedOutAt'
    && change.appImpact === true
  )));
});

test('런타임에서만 관찰한 ENUM이 사라진 것은 삭제로 판정하지 않는다', () => {
  const oldReport = reportFixture(['null'], ['ABSENT', 'PRESENT'], '동일');
  const newReport = reportFixture(['null'], [], '동일');
  oldReport.enums = [{
    id: 'field:label',
    name: null,
    field: 'label',
    values: ['WEEK1', 'WEEK2'],
    confidence: 'observed',
    evidence: [],
  }];
  newReport.enums = [];

  const result = diffReports(oldReport, newReport);

  assert.ok(!result.changes.some((change) => change.type === 'enum_removed'));
});

function reportFixture(types: SchemaType[], enumValues: string[], clientMessage: string): ObserverReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-16T00:00:00.000Z',
    target: { baseUrl: config.baseUrl, visitedRoutes: ['/check-in'], bundleCount: 1, bundles: [] },
    endpoints: {
      'GET /api/v2/me/cohorts/{cohortId}/attendance/today': {
        method: 'GET',
        path: '/api/v2/me/cohorts/{cohortId}/attendance/today',
        sources: ['static', 'runtime', 'app-dependency'],
        request: { pathParams: ['cohortId'], queryParams: {}, bodyFields: [], contentTypes: [] },
        responses: {
          '200': {
            types: ['object'],
            sampleCount: 1,
            properties: {
              checkedOutAt: { types, sampleCount: 1, presence: 'required' },
            },
          },
        },
        errors: [{ source: 'static-client', status: 403, errorCode: null, clientMessage }],
        observedErrors: [],
        evidence: [],
        appDependency: { fields: ['checkedOutAt'] },
      },
    },
    enums: [{
      id: 'attendance_status',
      name: 'attendance_status',
      field: 'status',
      values: enumValues,
      confidence: 'high',
      evidence: [],
    }],
    warnings: [],
  };
}
