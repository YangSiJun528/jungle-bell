import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./laundry-status-hint.tsx', import.meta.url), 'utf8');

describe('LaundryStatusHint', () => {
    it('정보 아이콘과 한국어 단어 단위 줄바꿈을 사용한다', () => {
        expect(source).toContain("import {Info} from 'lucide-react'");
        expect(source).toContain('<Info className="size-4" />');
        expect(source).toContain('space-y-1.5 leading-5 break-keep');
        expect(source).not.toMatch(/CircleHelp|CircleInfo/u);
    });
});
