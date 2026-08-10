import assert from 'node:assert/strict';
import {afterEach, describe, test, vi} from 'vitest';
import {loadImageWithTimeout} from './image-loader';

class FakeImage extends EventTarget {
    src = '';
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    decode = vi.fn<() => Promise<void>>().mockResolvedValue();
}

afterEach(() => {
    vi.useRealTimers();
});

describe('loadImageWithTimeout', () => {
    test('로드와 디코딩이 끝난 이미지를 반환한다', async () => {
        const image = new FakeImage();
        const loading = loadImageWithTimeout(image, 'https://example.com/api/public/assets/meal.png', 1_000);

        image.naturalWidth = 1200;
        image.naturalHeight = 800;
        image.complete = true;
        image.dispatchEvent(new Event('load'));

        await loading;
        assert.equal(image.src, 'https://example.com/api/public/assets/meal.png');
        assert.equal(image.decode.mock.calls.length, 1);
    });

    test('decode가 실패해도 유효한 크기가 있으면 성공으로 처리한다', async () => {
        const image = new FakeImage();
        image.decode.mockRejectedValueOnce(new Error('WebView2 decode failed'));
        const loading = loadImageWithTimeout(image, 'https://example.com/api/public/assets/meal.png', 1_000);

        image.naturalWidth = 1200;
        image.naturalHeight = 800;
        image.complete = true;
        image.dispatchEvent(new Event('load'));

        await loading;
    });

    test('이미지 오류를 호출자에게 전달한다', async () => {
        const image = new FakeImage();
        const loading = loadImageWithTimeout(image, 'https://example.com/api/public/assets/missing.png', 1_000);

        image.dispatchEvent(new Event('error'));

        await assert.rejects(loading, /이미지를 불러오지 못했습니다/);
    });

    test('제한 시간 안에 끝나지 않으면 실패한다', async () => {
        vi.useFakeTimers();
        const image = new FakeImage();
        const loading = loadImageWithTimeout(image, 'https://example.com/api/public/assets/slow.png', 15_000);
        const rejection = assert.rejects(loading, /시간이 초과되었습니다/);

        await vi.advanceTimersByTimeAsync(15_000);

        await rejection;
    });
});
