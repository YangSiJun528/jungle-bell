import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const campusHtml = readFileSync(new URL('./campus.html', import.meta.url), 'utf8');

test('워시타워 상세 카드는 실제 설치 구조대로 건조기를 세탁기 위에 표시한다', () => {
    assert.match(
        campusHtml,
        /x-for="entry in \[\{kind:'dryer', appliance:machine\.dryer}, \{kind:'washer', appliance:machine\.washer}]/,
    );
});
