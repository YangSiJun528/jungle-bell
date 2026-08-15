import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./laundry-page.tsx', import.meta.url), 'utf8');
const zoneSource = readFileSync(
    new URL('../../../components/dashboard/laundry-zone-presentation.ts', import.meta.url),
    'utf8',
);

describe('LaundryPage capacity summary', () => {
    it('시작 가능 카드도 구역 뱃지와 같은 중앙 색상 토큰을 사용한다', () => {
        expect(source).toContain('laundryZonePresentation(card.access).surfaceClassName');
        expect(zoneSource).toContain("surfaceClassName: 'border-blue-400");
        expect(zoneSource).toContain("surfaceClassName: 'border-rose-400");
        expect(zoneSource).toContain("surfaceClassName: 'border-violet-400");
        expect(source).toContain("card.status === 'checking'");
    });

    it('워시타워 범례에 구역과 별도 경고 뱃지를 함께 표시한다', () => {
        expect(source).toContain('aria-label="워시타워 구역 및 경고 범례"');
        expect(source).toContain('<LaundryWarningBadge/>');
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
