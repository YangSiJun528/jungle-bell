import assert from 'node:assert/strict';

import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'vitest';

import {AsyncState, ErrorState} from './async-state';

test('오류 재시도 버튼은 Alert 설명 열 안에 배치한다', () => {
    const markup = renderToStaticMarkup(
        <ErrorState description="연결 상태를 확인해 주세요." retry={() => undefined} />,
    );

    assert.match(
        markup,
        /data-slot="alert-description"[^>]*>[\s\S]*연결 상태를 확인해 주세요\.[\s\S]*새로고침[\s\S]*<\/div>/u,
    );
});

test('동적 loading/stale/offline/recovered만 status + polite로 알린다', () => {
    const loading = renderToStaticMarkup(<AsyncState type="loading" regionLabel="로딩 영역" />);
    const stale = renderToStaticMarkup(
        <AsyncState type="stale" lastUpdatedAt="2026-09-08 10:00" reason="요청 타임아웃" />,
    );
    const offline = renderToStaticMarkup(
        <AsyncState type="offline" regionLabelledBy="offline-title" />,
    );
    const recovered = renderToStaticMarkup(<AsyncState type="recovered" regionLabel="복구 영역" />);

    for (const markup of [loading, stale, offline, recovered]) {
        assert.match(markup, /role="status"/u);
        assert.match(markup, /aria-live="polite"/u);
    }

    assert.match(loading, /aria-label="로딩 영역"/u);
    assert.match(recovered, /aria-label="복구 영역"/u);
});

test('정적 empty는 이름 있는 region이지만 live status는 아니다', () => {
    const empty = renderToStaticMarkup(
        <AsyncState type="empty" title="데이터 없음" regionLabel="빈 상태 영역" />,
    );

    assert.match(empty, /role="region"/u);
    assert.match(empty, /aria-label="빈 상태 영역"/u);
    assert.doesNotMatch(empty, /role="status"/u);
    assert.doesNotMatch(empty, /aria-live=/u);
});

test('재시도 텍스트/핸들러는 stale/offline/recovered에서 주입 가능하고 마지막 정상 시각·이유를 렌더링한다', () => {
    let called = false;
    const markup = renderToStaticMarkup(
        <AsyncState
            type="stale"
            lastUpdatedAt="2026-09-08 11:00"
            reason="일시적 장애"
            retryLabel="다시 시도"
            retry={() => {
                called = true;
            }}
        />,
    );

    assert.match(markup, /마지막 정상 시각/iu);
    assert.match(markup, /2026-09-08 11:00/u);
    assert.match(markup, /일시적 장애/u);
    assert.match(markup, /다시 시도/u);

    assert.equal(called, false);
});

test('normal은 이름 있는 region, error는 assertive alert로 즉시 알린다', () => {
    const normal = renderToStaticMarkup(
        <AsyncState type="normal" regionLabel="정상 데이터 영역">
            <p>정상 데이터</p>
        </AsyncState>,
    );
    const error = renderToStaticMarkup(
        <AsyncState type="error" title="조회 실패" description="다시 시도해 주세요." />,
    );

    assert.match(normal, /role="region"/u);
    assert.match(normal, /aria-label="정상 데이터 영역"/u);
    assert.match(error, /role="alert"/u);
    assert.match(error, /aria-live="assertive"/u);
    assert.doesNotMatch(error, /role="status"/u);
});

test('loading/empty/error/degraded 본문은 16px 이상 안내 토큰을 사용한다', () => {
    const states = [
        renderToStaticMarkup(<AsyncState type="loading" />),
        renderToStaticMarkup(
            <AsyncState type="empty" title="내용 없음" description="표시할 내용이 없습니다." />,
        ),
        renderToStaticMarkup(
            <AsyncState type="error" title="조회 실패" description="다시 시도해 주세요." />,
        ),
        renderToStaticMarkup(
            <AsyncState type="stale" description="마지막 정상 데이터를 표시합니다." />,
        ),
        renderToStaticMarkup(
            <AsyncState type="recovered" description="최신 데이터로 복구했습니다." />,
        ),
    ];

    for (const markup of states) {
        assert.match(markup, /text-base/u);
        assert.match(markup, /leading-6/u);
    }

    assert.match(states[2]!, /data-slot="alert-title"[^>]*text-base[^>]*leading-6/u);
});

test('오류와 stale 복구 버튼은 최소 44px 조작 영역을 사용한다', () => {
    const error = renderToStaticMarkup(<AsyncState type="error" retry={() => undefined} />);
    const stale = renderToStaticMarkup(<AsyncState type="stale" retry={() => undefined} />);

    assert.match(error, /min-h-11/u);
    assert.match(stale, /min-h-11/u);
});
