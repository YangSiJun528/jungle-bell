import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./app-status-page.tsx', import.meta.url), 'utf8');

describe('AppStatusPage', () => {
    test('상태 행마다 상태 텍스트, 복구 동작, polite live feedback을 제공한다', () => {
        expect(source).toContain('aria-live="polite"');
        expect(source).toContain('row.action');
        expect(source).toContain('AppStatusRow');
        expect(source).toContain('앱 상태');
    });

    test('현재 계약으로 확인할 수 없는 값은 확인 불가로 표시한다', () => {
        expect(source).toContain('확인 불가');
        expect(source).toContain('현재 계약에서 확인할 수 없습니다.');
    });
});
