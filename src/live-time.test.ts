import assert from 'node:assert/strict';
import test from 'node:test';
import {relativeTimeKo} from './live-time.ts';

test('최근 갱신 상대 시간은 현재 UI 시각에 따라 초 단위로 변한다', () => {
    const checkedAt = '2026-07-20T06:00:00.000Z';

    assert.equal(relativeTimeKo(checkedAt, Date.parse('2026-07-20T06:00:12.000Z')), '12초 전');
    assert.equal(relativeTimeKo(checkedAt, Date.parse('2026-07-20T06:00:13.000Z')), '13초 전');
    assert.equal(relativeTimeKo(checkedAt, Date.parse('2026-07-20T06:01:00.000Z')), '1분 전');
});
