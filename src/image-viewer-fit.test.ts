import assert from 'node:assert/strict';
import {test} from 'vitest';
import {calculateImageFitScale} from './image-viewer-fit.ts';

test('이미지 화면 맞춤 배율은 가로와 세로 제한 중 작은 값을 사용한다', () => {
    assert.equal(calculateImageFitScale(1120, 840, 2000, 1000), 0.56);
    assert.equal(calculateImageFitScale(1120, 840, 1000, 2000), 0.42);
    assert.equal(calculateImageFitScale(800, 600, 400, 200), 2);
});

test('유효하지 않은 크기는 안전한 기본 배율을 사용한다', () => {
    assert.equal(calculateImageFitScale(0, 600, 400, 200), 1);
    assert.equal(calculateImageFitScale(800, 600, 0, 200), 1);
    assert.equal(calculateImageFitScale(Number.NaN, 600, 400, 200), 1);
});
