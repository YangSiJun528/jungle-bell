import assert from 'node:assert/strict';
import test from 'node:test';

import { extractStaticContracts, mergeEnumCandidates } from '../lib/static-extractor.ts';

const source = `
const attendanceLabels = {
  PRESENT: "출석",
  ABSENT: "결석",
  LATE: "지각",
  SELF_STUDY: "자율 학습",
};

const listAttendances = async (e, t) => {
  try {
    return await client.fT.get(
      \`/me/cohorts/\${e}/attendances\`,
      { params: { page: t?.page ?? 1, pageSize: t?.pageSize ?? 25 } },
    );
  } catch (error) {
    if (isHttpError(error)) throw Error("출석 기록을 불러오는데 실패했어요.");
    throw error;
  }
};

const checkOut = async (e) => {
  try {
    return await client.fT.post(\`/me/cohorts/\${e}/attendance/check-out\`);
  } catch (error) {
    if (
      error.response?.status === 403 &&
      error.response?.data?.errorCode === "PEER_FEEDBACK_REQUIRED"
    ) {
      throw Error("동료 피드백을 먼저 완료해주세요.");
    }
    throw error;
  }
};

const quota = (e) => fetch(\`/api/me/cohorts/\${e}/leave-quota-configs\`);
`;

test('API 클라이언트 별칭과 무관하게 엔드포인트와 오류를 추출한다', () => {
  const result = extractStaticContracts(
    [{ name: 'page.js', url: 'https://example.test/page.js', sha256: 'fixture', code: source }],
    { relativeApiBasePath: '/api/v2' },
  );

  const list = result.endpoints['GET /api/v2/me/cohorts/{cohortId}/attendances'];
  assert.ok(list);
  assert.deepEqual(list.request.queryParams, {
    page: { default: 1 },
    pageSize: { default: 25 },
  });
  assert.ok(list.errors.some((error) => error.clientMessage === '출석 기록을 불러오는데 실패했어요.'));

  const checkout = result.endpoints['POST /api/v2/me/cohorts/{cohortId}/attendance/check-out'];
  assert.ok(checkout);
  assert.ok(checkout.errors.some((error) => (
    error.status === 403
    && error.errorCode === 'PEER_FEEDBACK_REQUIRED'
    && error.clientMessage === '동료 피드백을 먼저 완료해주세요.'
  )));

  assert.ok(result.endpoints['GET /api/me/cohorts/{cohortId}/leave-quota-configs']);
});

test('객체 키 기반 ENUM을 근거와 함께 추출한다', () => {
  const result = extractStaticContracts(
    [{ name: 'page.js', url: 'https://example.test/page.js', sha256: 'fixture', code: source }],
    { relativeApiBasePath: '/api/v2' },
  );

  const attendance = result.enums.find((candidate) => candidate.name === 'attendance_status');
  assert.ok(attendance);
  assert.deepEqual(attendance.values, ['ABSENT', 'LATE', 'PRESENT', 'SELF_STUDY']);
  assert.equal(attendance.confidence, 'high');
  assert.ok(attendance.evidence.some((item) => item.kind === 'object-keys'));
});

test('API와 무관한 프레임워크 번들의 상수는 ENUM 후보에서 제외한다', () => {
  const result = extractStaticContracts([
    { name: 'page.js', url: 'https://example.test/page.js', sha256: 'app', code: source },
    {
      name: 'framework.js',
      url: 'https://example.test/framework.js',
      sha256: 'framework',
      code: 'const headers = { ACTION_HEADER: "x", NEXT_URL: "y", RSC_HEADER: "z" };',
    },
  ], { relativeApiBasePath: '/api/v2' });

  assert.ok(result.enums.some((candidate) => candidate.id === 'attendance_status'));
  assert.ok(!result.enums.some((candidate) => candidate.values.includes('ACTION_HEADER')));
});

test('정적 ENUM과 같은 값을 관찰한 필드 후보를 하나로 합친다', () => {
  const evidence = { kind: 'object-keys' as const, bundle: 'page.js', sha256: 'app' };
  const result = mergeEnumCandidates([
    {
      id: 'enum:birth',
      name: null,
      field: null,
      values: ['BIRTH', 'DEATH', 'ILLNESS', 'MARRIAGE'],
      confidence: 'high',
      evidence: [evidence],
    },
    {
      id: 'field:category',
      name: null,
      field: 'category',
      values: ['BIRTH', 'DEATH', 'ILLNESS', 'MARRIAGE'],
      confidence: 'observed',
      evidence: [{ kind: 'runtime-observed', endpoint: 'GET /api/example', status: 200 }],
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, 'field:category');
  assert.equal(result[0]?.confidence, 'high');
});

test('알려진 휴가 분류와 대상 ENUM에 안정적인 이름을 부여한다', () => {
  const result = extractStaticContracts([{
    name: 'leave.js',
    url: 'https://example.test/leave.js',
    sha256: 'leave',
    code: `
      const categories = { BIRTH: '출산', DEATH: '사망', ILLNESS: '질병', MARRIAGE: '결혼' };
      const targets = { CHILD: '자녀', GRANDPARENT: '조부모', PARENT: '부모', SIBLING: '형제', SPOUSE: '배우자' };
      client.get('/me/cohorts');
    `,
  }], { relativeApiBasePath: '/api/v2' });

  assert.ok(result.enums.some((candidate) => candidate.id === 'official_leave_category'));
  assert.ok(result.enums.some((candidate) => candidate.id === 'official_leave_target'));
});
