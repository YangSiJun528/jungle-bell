import assert from 'node:assert/strict';
import {test} from 'vitest';
import {buildDdayProgress, kstDateString, type DdayPeriod} from './dday-progress.ts';

const TEN_DAY_COURSE: DdayPeriod = {
    startDate: '2026-01-01',
    endDate: '2026-01-10',
};

test('가로 31일과 세로 월로 코스 기간을 한 그리드에 배치한다', () => {
    const progress = buildDdayProgress(
        {startDate: '2026-01-29', endDate: '2026-03-02'},
        '2026-02-02',
    );

    assert.ok(progress);
    assert.equal(progress.total, 33);
    assert.equal(progress.elapsed, 4);
    assert.equal(progress.remaining, 28);
    assert.equal(progress.current, 1);
    assert.equal(progress.percent, 12.1);
    assert.deepEqual(
        progress.rows.map(({key, label, shortLabel}) => ({key, label, shortLabel})),
        [
            {key: '2026-01', label: '2026년 1월', shortLabel: '1월'},
            {key: '2026-02', label: '2026년 2월', shortLabel: '2월'},
            {key: '2026-03', label: '2026년 3월', shortLabel: '3월'},
        ],
    );
    assert.ok(progress.rows.every((row) => row.cells.length === 31));

    const january = progress.rows[0]!.cells;
    const february = progress.rows[1]!.cells;
    const march = progress.rows[2]!.cells;

    assert.ok(january.slice(0, 28).every((cell) => cell === null));
    assert.equal(january[28]?.key, '2026-01-29');
    assert.equal(january[28]?.state, 'elapsed');
    assert.equal(january[30]?.key, '2026-01-31');
    assert.equal(february[0]?.state, 'elapsed');
    assert.equal(february[1]?.state, 'current');
    assert.equal(february[27]?.state, 'remaining');
    assert.ok(february.slice(28).every((cell) => cell === null));
    assert.equal(march[0]?.state, 'remaining');
    assert.equal(march[1]?.state, 'remaining');
    assert.ok(march.slice(2).every((cell) => cell === null));
});

test('오늘은 완료와 잔여에서 분리한다', () => {
    const progress = buildDdayProgress(TEN_DAY_COURSE, '2026-01-04');

    assert.ok(progress);
    assert.equal(progress.total, 10);
    assert.equal(progress.elapsed, 3);
    assert.equal(progress.remaining, 6);
    assert.equal(progress.current, 1);
    assert.equal(progress.percent, 30);
    assert.deepEqual(
        progress.rows[0]!.cells.filter((cell) => cell !== null).map((cell) => cell.state),
        [
            'elapsed',
            'elapsed',
            'elapsed',
            'current',
            'remaining',
            'remaining',
            'remaining',
            'remaining',
            'remaining',
            'remaining',
        ],
    );
});

test('연도가 바뀌어도 월 행을 순서대로 만든다', () => {
    const progress = buildDdayProgress(
        {startDate: '2025-12-15', endDate: '2026-04-10'},
        '2026-02-20',
    );

    assert.ok(progress);
    assert.equal(progress.rows.length, 5);
    assert.equal(progress.rows[0]?.label, '2025년 12월');
    assert.equal(progress.rows[4]?.label, '2026년 4월');
    assert.equal(progress.current, 1);
});

test('시작 전과 종료 후에는 현재 칸 없이 전체 잔여 또는 완료로 표시한다', () => {
    const upcoming = buildDdayProgress(TEN_DAY_COURSE, '2025-12-31');
    const ended = buildDdayProgress(TEN_DAY_COURSE, '2026-01-11');

    assert.ok(upcoming);
    assert.deepEqual(
        {elapsed: upcoming.elapsed, current: upcoming.current, remaining: upcoming.remaining, percent: upcoming.percent},
        {elapsed: 0, current: 0, remaining: 10, percent: 0},
    );
    assert.ok(ended);
    assert.deepEqual(
        {elapsed: ended.elapsed, current: ended.current, remaining: ended.remaining, percent: ended.percent},
        {elapsed: 10, current: 0, remaining: 0, percent: 100},
    );
});

test('KST 날짜는 UTC 오후 3시를 경계로 바뀐다', () => {
    assert.equal(kstDateString(Date.parse('2026-07-26T14:59:59Z')), '2026-07-26');
    assert.equal(kstDateString(Date.parse('2026-07-26T15:00:00Z')), '2026-07-27');
});

test('잘못되거나 비정상적으로 긴 기간은 시각화하지 않는다', () => {
    assert.equal(buildDdayProgress({startDate: '2026-02-30', endDate: '2026-03-01'}, '2026-03-01'), null);
    assert.equal(buildDdayProgress({startDate: '2026-03-02', endDate: '2026-03-01'}, '2026-03-01'), null);
    assert.equal(buildDdayProgress({startDate: '2020-01-01', endDate: '2030-01-01'}, '2026-03-01'), null);
});
