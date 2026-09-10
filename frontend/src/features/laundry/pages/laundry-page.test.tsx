import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./laundry-page.tsx', import.meta.url), 'utf8');
const boundarySource = readFileSync(
    new URL('../components/laundry-feature-boundary.tsx', import.meta.url),
    'utf8',
);
const zoneSource = readFileSync(
    new URL('../../../components/dashboard/laundry-zone-presentation.ts', import.meta.url),
    'utf8',
);

describe('LaundryPage capacity summary', () => {
    it('시작 가능 카드도 구역 뱃지와 같은 중앙 색상 토큰을 사용한다', () => {
        expect(source).toContain('laundryZonePresentation(card.access).surfaceClassName');
        expect(zoneSource).toMatch(/surfaceClassName:\s*'border-blue-400/u);
        expect(zoneSource).toMatch(/surfaceClassName:\s*'border-rose-400/u);
        expect(zoneSource).toMatch(/surfaceClassName:\s*'border-violet-400/u);
        expect(source).toContain("card.status === 'checking'");
    });

    it('워시타워 범례에 구역과 별도 경고 뱃지를 함께 표시한다', () => {
        expect(source).toContain('aria-label="워시타워 구역 및 경고 범례"');
        expect(source).toContain('<LaundryWarningBadge />');
    });

    it('수집 서버 상태 플래그가 꺼지면 마지막 정상 데이터 경고를 표시한다', () => {
        expect(source).toContain('const collectorUnavailable = !snapshot.quality.collectorHealthy');
        expect(source).toMatch(/const reliable\s*=\s*snapshot\.quality\.collectorHealthy/u);
        expect(source).toContain('세탁실 수집 서버에 문제가 있습니다.');
        expect(source).toContain('실시간 상태를 확인할 수 없어 마지막 정상 데이터를 표시합니다.');
    });

    it('횟수와 지금 시작 가능 의미를 한 줄로 표시한다', () => {
        expect(source).toContain('items-baseline');
        expect(source).toMatch(
            /\{card\.count === null \? '—' : `\$\{card\.count\}회`\}[\s\S]*지금 시작 가능/u,
        );
    });

    it('설명이 없는 시작 가능 카드는 같은 높이 안에서 세로 중앙 정렬한다', () => {
        expect(source).toMatch(/card\.status === 'available'[\s\S]*'justify-center'/u);
    });

    it('워시타워 표는 구분선 아래에 작은 대칭 여백만 둔다', () => {
        expect(source).toContain('<CardContent className="px-4 pt-0 pb-3 sm:px-6">');
        expect(source).toContain('[.border-b]:pb-3');
    });

    it('platform capability gates one switch that controls both risk presentations', () => {
        expect(source).toContain('platform.capabilities.laundryRiskIndicator');
        expect(source).toContain('최근 7일 에러 위험 표시');
        expect(source).toContain('onCheckedChange={onCheckedChange}');
        expect(source).toContain('onShowRiskChange={setShowRisk}');
        expect(source).toContain('showRiskIndicators={showRisk}');
        expect(source).toContain('showRiskWarnings={showRisk}');
        expect(source).toContain("import {SwitchRow} from '@/components/ui/switch'");
        expect(source).toContain('<SwitchRow');
        expect(source).toContain('data-laundry-risk-toggle-row="true"');
        expect(source).toContain('min-h-(--control-height-lg)');
        expect(source).not.toContain('<Switch\n');
        expect(source).not.toContain('전체 에러율');
        expect(source).not.toContain('에러 위험 요약');
    });

    it('주요 설명은 16px 본문 계약을 사용하고 중복 섹션 이동 링크를 두지 않는다', () => {
        expect(source).toMatch(/<CardDescription className="text-base leading-6">/u);
        expect(source).toMatch(/<span className="text-base leading-6 font-normal/u);
        expect(source).not.toContain('LAUNDRY_JUMPS');
        expect(source).not.toContain('LaundryJumpNavigation');
        expect(source).not.toContain('aria-label="세부 섹션 이동"');
    });

    it('페이지 헤더 밖의 local async boundary로 세탁 실패를 격리한다', () => {
        const pageSource = source.slice(source.indexOf('export function LaundryPage()'));

        expect(pageSource.indexOf('<PageHeader')).toBeLessThan(
            pageSource.indexOf('<LaundryDataRegion'),
        );
        expect(boundarySource).toContain('<AsyncBoundary');
        expect(boundarySource).toContain('regionLabel="세탁실 데이터"');
        expect(boundarySource).toContain('type="offline"');
    });

    it('마지막 정상 시각을 페이지 데이터 범위에서 한 번만 안내한다', () => {
        expect(source).toContain('<LaundryStatusNotice');
        expect(source).toContain("data-data-state={presentation.dataStale ? 'stale' : 'current'}");
        expect(source.match(/lastUpdatedAt=/gu)).toHaveLength(1);
        expect(source).not.toContain('staleBanner');
    });
});
