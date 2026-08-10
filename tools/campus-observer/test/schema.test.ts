import assert from 'node:assert/strict';
import test from 'node:test';

import { extractObservedErrorMetadata, inferSchemaFromSamples } from '../lib/schema.ts';

test('여러 응답 샘플의 필드 타입과 ENUM 후보를 병합한다', () => {
  const schema = inferSchemaFromSamples([
    [{ status: 'PRESENT', checkedAt: null, profile: { level: 1 } }],
    [{ status: 'ABSENT', checkedAt: '2026-07-16T09:00:00Z', checkedOutAt: null, profile: { level: 2 } }],
  ]);

  assert.deepEqual(schema.types, ['array']);
  assert.deepEqual(schema.items?.properties?.checkedAt?.types, ['null', 'string']);
  assert.deepEqual(schema.items?.properties?.status?.enumCandidates, ['ABSENT', 'PRESENT']);
  assert.deepEqual(schema.items?.properties?.profile?.properties?.level?.types, ['number']);
  assert.equal(schema.items?.properties?.checkedOutAt?.presence, 'optional');
});

test('관찰된 오류에서 코드와 개인정보를 제거한 메시지만 남긴다', () => {
  const metadata = extractObservedErrorMetadata({
    errorCode: 'PEER_FEEDBACK_REQUIRED',
    message: 'user@example.com 사용자의 요청 c12345678901234567890 실패',
  });

  assert.deepEqual(metadata.errorCodes, ['PEER_FEEDBACK_REQUIRED']);
  assert.deepEqual(metadata.messages, ['[EMAIL] 사용자의 요청 [ID] 실패']);
});

test('일반 대문자 문자열과 단일 값은 런타임 ENUM 값으로 저장하지 않는다', () => {
  const schema = inferSchemaFromSamples([{ name: 'ALICE', status: 'PRESENT' }]);

  assert.equal(schema.properties?.name?.enumCandidates, undefined);
  assert.equal(schema.properties?.status?.enumCandidates, undefined);
});

test('일반 텍스트 오류 응답도 개인정보를 익명화해 메시지로 남긴다', () => {
  const metadata = extractObservedErrorMetadata('user@example.com 요청이 실패했습니다.');

  assert.deepEqual(metadata.messages, ['[EMAIL] 요청이 실패했습니다.']);
});
