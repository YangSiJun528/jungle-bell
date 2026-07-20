import assert from 'node:assert/strict';
import test from 'node:test';
import {sortMealPostsByPeriod} from './meal-display.ts';

test('같은 날짜의 식단은 게시 시각과 무관하게 중식 다음 석식 순서로 정렬한다', () => {
    const dinner = {title: '7월 20일 석식', publishedAt: '2026-07-20T01:00:00Z'};
    const lunch = {title: '7월 20일 중식', publishedAt: '2026-07-20T02:00:00Z'};

    assert.deepEqual(sortMealPostsByPeriod([dinner, lunch]), [lunch, dinner]);
});

test('식사 구분이 같거나 없으면 기존 게시 순서를 유지한다', () => {
    const firstLunch = {title: '중식 A'};
    const secondLunch = {title: '중식 B'};
    const general = {title: '급식 안내'};

    assert.deepEqual(
        sortMealPostsByPeriod([general, firstLunch, secondLunch]),
        [firstLunch, secondLunch, general],
    );
});

test('원본 식단 배열은 변경하지 않는다', () => {
    const posts = [{title: '석식'}, {title: '중식'}];

    sortMealPostsByPeriod(posts);

    assert.deepEqual(posts.map((post) => post.title), ['석식', '중식']);
});
