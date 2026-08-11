import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./laundry-page.tsx', import.meta.url), 'utf8');

describe('LaundryPage capacity summary', () => {
    it('신뢰할 수 있는 시작 가능 카드를 남성과 여성의 차분한 색으로 구분한다', () => {
        expect(source).toContain("card.access === 'men'");
        expect(source).toMatch(/border-blue-[^'\s]+[\s\S]*bg-blue-[^'\s]+/u);
        expect(source).toMatch(/border-rose-[^'\s]+[\s\S]*bg-rose-[^'\s]+/u);
        expect(source).toContain("card.status === 'checking'");
    });

    it('횟수와 지금 시작 가능 의미를 한 줄로 표시한다', () => {
        expect(source).toContain('items-baseline');
        expect(source).toMatch(/\{card\.count === null \? '—' : `\$\{card\.count\}회`\}[\s\S]*지금 시작 가능/u);
    });

    it('설명이 없는 시작 가능 카드는 같은 높이 안에서 세로 중앙 정렬한다', () => {
        expect(source).toMatch(/card\.status === 'available'[\s\S]*'justify-center'/u);
    });

    it('워시타워 표는 구분선 아래에 작은 대칭 여백만 둔다', () => {
        expect(source).toContain('<CardContent className="px-4 pb-3 pt-0 sm:px-6">');
        expect(source).toContain('[.border-b]:pb-3');
    });
});
