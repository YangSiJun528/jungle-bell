import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('Pretendard Variable 폰트는 크로스 플랫폼 선언과 fallback을 사용한다', () => {
    assert.match(styles, /font-family:\s*["']Pretendard Variable["']/);
    assert.match(styles, /format\(["']woff2-variations["']\)/);
    assert.match(styles, /--font-family:\s*["']Pretendard Variable["'],\s*Pretendard,/);
});
