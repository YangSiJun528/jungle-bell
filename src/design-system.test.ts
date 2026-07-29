import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const foundationStyles = readSource('./styles.css');
const uiStyles = readSource('./ui.css');
const pagePaths = [
    './index.html',
    './onboarding.html',
    './campus.html',
    './tray-panel.html',
    './alert-overlay.html',
    './image-viewer.html',
];
const pages = pagePaths.map((path) => ({path, source: readSource(path)}));
const withoutMicroVisualization = (source: string) => source.replace(
    /<[^>]+data-ui-density="micro"[\s\S]*?<!-- ui-density:micro:end -->/g,
    '',
);

test('공통 간격은 4px 기반의 제한된 토큰만 사용한다', () => {
    const spacingTokens = [
        ['space-1', '4px'],
        ['space-2', '8px'],
        ['space-3', '12px'],
        ['space-4', '16px'],
        ['space-6', '24px'],
        ['space-8', '32px'],
        ['space-12', '48px'],
        ['space-16', '64px'],
    ] as const;

    for (const [name, value] of spacingTokens) {
        assert.match(foundationStyles, new RegExp(`--${name}:\\s*${value}`));
    }

    for (const {path, source} of pages) {
        const standardDensitySource = withoutMicroVisualization(source);
        assert.doesNotMatch(
            standardDensitySource,
            /\b(?:m[trblxy]?|p[trblxy]?|gap)-\[[^\]]+\]/,
            `${path}에 토큰 밖의 임의 간격이 있습니다.`,
        );
        assert.doesNotMatch(
            standardDensitySource,
            /\b(?:m[trblxy]?|p[trblxy]?|gap(?:-[xy])?|space-[xy])-\d+\.5\b/,
            `${path}에 4px 보조 단위보다 작은 반 단위 간격이 있습니다.`,
        );
        assert.doesNotMatch(
            standardDensitySource,
            /\brounded-\[[^\]]+\]/,
            `${path}에 공통 radius 역할 밖의 임의 모서리 값이 있습니다.`,
        );
    }
});

test('타이포그래피는 다섯 단계와 두 가지 강조 굵기로 제한한다', () => {
    const typeTokens = [
        ['font-size-caption', '12px'],
        ['font-size-label', '14px'],
        ['font-size-body', '16px'],
        ['font-size-title', '20px'],
        ['font-size-display', '24px'],
    ] as const;

    for (const [name, value] of typeTokens) {
        assert.match(foundationStyles, new RegExp(`--${name}:\\s*${value}`));
    }

    assert.match(foundationStyles, /--font-weight-regular:\s*400/);
    assert.match(foundationStyles, /--font-weight-emphasis:\s*700/);
    assert.match(uiStyles, /--text-xs:\s*var\(--font-size-caption\)/);
    assert.match(uiStyles, /--text-sm:\s*var\(--font-size-label\)/);
    assert.match(uiStyles, /--text-base:\s*var\(--font-size-body\)/);
    assert.match(uiStyles, /--text-lg:\s*var\(--font-size-title\)/);
    assert.match(uiStyles, /--text-2xl:\s*var\(--font-size-display\)/);

    for (const {path, source} of pages) {
        const standardDensitySource = withoutMicroVisualization(source);
        assert.doesNotMatch(
            standardDensitySource,
            /\btext-\[[0-9]+px\]/,
            `${path}에 체계 밖의 임의 글자 크기가 있습니다.`,
        );
        assert.doesNotMatch(
            standardDensitySource,
            /\bfont-(?:thin|extralight|light|medium|semibold|extrabold|black)\b/,
            `${path}에 regular/bold 밖의 글자 굵기가 있습니다.`,
        );
        for (const match of standardDensitySource.matchAll(/<small\b[^>]*class="([^"]*)"/g)) {
            const classes = match[1] ?? '';
            assert.match(
                classes,
                /\b(?:ui-settings-description|text-(?:ui-(?:caption|label|body|title|display)|xs|sm|base|lg|2xl))\b/,
                `${path}의 small 요소가 브라우저 기본 축소 비율을 사용합니다.`,
            );
        }
    }
});

test('색상은 의미 기반 토큰과 near-white 전경색을 사용한다', () => {
    for (const token of [
        'color-bg',
        'color-surface',
        'color-surface-raised',
        'color-surface-inverse',
        'color-text',
        'color-text-muted',
        'color-border',
        'color-accent',
        'color-success',
        'color-warning',
        'color-danger',
        'color-on-accent',
        'color-on-inverse',
        'color-status-neutral',
    ]) {
        assert.match(foundationStyles, new RegExp(`--${token}:`));
    }

    assert.doesNotMatch(foundationStyles, /--jungle-(?:paper|overlay):\s*(?:#fff(?:fff)?\b|white\b|oklch\(100% 0 0\))/i);
    for (const {path, source} of pages) {
        assert.doesNotMatch(source, /\b(?:text|bg)-(?:black|white)\b/, `${path}가 순수 흑백 유틸리티를 사용합니다.`);
        assert.doesNotMatch(
            source,
            /\bbg-app-(?:text|muted|faint|disabled)\b/,
            `${path}가 텍스트 역할 색상을 배경에 사용합니다.`,
        );
        assert.doesNotMatch(
            source,
            /\btext-app-(?:bg|surface|raised|overlay|control)\b/,
            `${path}가 표면 역할 색상을 전경에 사용합니다.`,
        );
    }
});

test('모든 창은 같은 UI 프리미티브와 페이지 역할을 사용한다', () => {
    assert.match(foundationStyles, /--radius-control:\s*8px/);
    assert.match(foundationStyles, /--radius-card:\s*12px/);
    assert.match(foundationStyles, /--radius-window:\s*20px/);

    for (const selector of [
        '.ui-page-header',
        '.ui-page-title',
        '.ui-page-subtitle',
        '.ui-tabs',
        '.ui-tab',
        '.ui-card',
        '.ui-section-title',
        '.ui-button',
        '.ui-control',
        '.ui-badge',
        '.ui-popover',
        '.ui-progress',
        '.ui-empty-state',
    ]) {
        assert.match(uiStyles, new RegExp(`\\${selector}\\b`));
    }

    for (const {path, source} of pages) {
        assert.match(source, /<body\b[^>]*\bdata-ui-page="[^"]+"/, `${path}에 페이지 역할이 없습니다.`);
        assert.doesNotMatch(
            source,
            /\b(?:peer-)?focus-visible:ring-/,
            `${path}가 공통 포커스 링을 개별 유틸리티로 덮어씁니다.`,
        );
    }
    assert.match(uiStyles, /\.peer:focus-visible \+ \.ui-focus-proxy\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/s);
    assert.match(uiStyles, /select\.ui-control\s*\{[^}]*height:\s*40px/s);
});

test('상태 배지·팝오버·진행률은 반복 가능한 공통 컴포넌트를 사용한다', () => {
    const campus = readSource('./campus.html');
    const onboarding = readSource('./onboarding.html');
    const tray = readSource('./tray-panel.html');

    assert.match(campus, /\bui-badge\b/);
    assert.match(campus, /\bui-popover\b/);
    assert.match(campus, /\bui-progress\b/);
    assert.match(onboarding, /\bui-progress\b/);
    assert.match(tray, /\bui-progress\b/);
});

test('기본 표면은 테두리 없이 배경과 여백으로 구분한다', () => {
    const cardRule = uiStyles.match(/\.ui-card\s*\{([^}]*)\}/)?.[1] ?? '';
    const emptyStateRule = uiStyles.match(/\.ui-empty-state\s*\{([^}]*)\}/)?.[1] ?? '';
    const floatingSurfaceRule = uiStyles.match(/\.ui-floating-surface\s*\{([^}]*)\}/)?.[1] ?? '';

    assert.match(cardRule, /\bborder:\s*0\s*;/);
    assert.match(cardRule, /\bbackground:\s*var\(--color-surface\)\s*;/);
    assert.match(emptyStateRule, /\bborder:\s*0\s*;/);
    assert.match(emptyStateRule, /\bbackground:\s*var\(--color-surface-subtle\)\s*;/);
    assert.match(floatingSurfaceRule, /\bborder:\s*1px solid var\(--color-border\)\s*;/);
    assert.match(foundationStyles, /--color-border:\s*oklch\(0% 0 0 \/ 6%\)/);
    assert.match(foundationStyles, /--color-border-strong:\s*oklch\(0% 0 0 \/ 12%\)/);
});

test('고대비 모드에서도 커스텀 선택 항목은 색상 외의 표시를 제공한다', () => {
    assert.match(
        uiStyles,
        /@media \(forced-colors: active\)[\s\S]*\.peer:checked \+ \.ui-focus-proxy::before\s*\{[^}]*content:\s*"✓"/,
    );
});
