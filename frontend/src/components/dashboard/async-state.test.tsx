import assert from 'node:assert/strict';

import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'vitest';

import {ErrorState} from './async-state';

test('오류 재시도 버튼은 Alert 설명 열 안에 배치한다', () => {
    const markup = renderToStaticMarkup(
        <ErrorState description="연결 상태를 확인해 주세요." retry={() => undefined} />,
    );

    assert.match(
        markup,
        /data-slot="alert-description"[^>]*>[\s\S]*연결 상태를 확인해 주세요\.[\s\S]*새로고침[\s\S]*<\/div>/u,
    );
});
