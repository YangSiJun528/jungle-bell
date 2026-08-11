import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const globals = source('./app/styles/globals.css');
const shadcnConfig = JSON.parse(source('../components.json')) as {
    style: string;
    rsc: boolean;
    tsx: boolean;
    tailwind: {css: string; cssVariables: boolean};
    aliases: Record<string, string>;
};

const uiComponents = [
    'alert',
    'badge',
    'button',
    'card',
    'input',
    'label',
    'select',
    'separator',
    'skeleton',
    'switch',
    'tooltip',
] as const;

test('shadcn/ui 설정은 React SPA의 로컬 컴포넌트와 Tailwind 전역 스타일을 가리킨다', () => {
    assert.equal(shadcnConfig.style, 'new-york');
    assert.equal(shadcnConfig.rsc, false);
    assert.equal(shadcnConfig.tsx, true);
    assert.equal(shadcnConfig.tailwind.css, 'src/app/styles/globals.css');
    assert.equal(shadcnConfig.tailwind.cssVariables, true);
    assert.equal(shadcnConfig.aliases.ui, '@/components/ui');
    assert.equal(shadcnConfig.aliases.utils, '@/lib/utils');
    assert.equal(shadcnConfig.aliases.components, '@/components');
});

test('필요한 shadcn/ui 프리미티브는 외부 런타임 생성 없이 저장소에 vendoring한다', () => {
    for (const component of uiComponents) {
        const path = `./components/ui/${component}.tsx`;
        assert.equal(existsSync(new URL(path, import.meta.url)), true, `${component} 컴포넌트가 없습니다.`);
        assert.match(source(path), /data-slot=/, `${component}에 shadcn slot 계약이 없습니다.`);
    }

    const utils = source('./lib/utils.ts');
    assert.match(utils, /clsx\(inputs\)/);
    assert.match(utils, /twMerge\(/);
});

test('Tailwind 4와 shadcn 토큰은 하나의 전역 스타일 진입점에서 구성한다', () => {
    assert.match(globals, /@import ["']tailwindcss["']/);
    assert.match(globals, /@import ["']tw-animate-css["']/);
    assert.match(globals, /@custom-variant dark \(&:is\(\.dark \*\)\)/);
    assert.match(globals, /@theme inline\s*\{/);

    for (const token of [
        'background',
        'foreground',
        'card',
        'primary',
        'secondary',
        'muted',
        'accent',
        'destructive',
        'border',
        'ring',
        'sidebar',
    ]) {
        assert.match(globals, new RegExp(`--${token}:`), `--${token} 토큰이 없습니다.`);
        assert.match(globals, new RegExp(`--color-${token}:\\s*var\\(--${token}\\)`), `--${token} Tailwind 매핑이 없습니다.`);
    }
    assert.match(globals, /--radius-sm:\s*calc\(var\(--radius\) - 4px\)/);
    assert.match(globals, /--radius-lg:\s*var\(--radius\)/);
});

test('라이트와 다크 테마는 동일한 의미 기반 토큰 집합을 재정의한다', () => {
    const rootBlock = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const darkBlock = globals.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const tokenNames = [
        'background',
        'foreground',
        'card',
        'card-foreground',
        'popover',
        'primary',
        'primary-foreground',
        'secondary',
        'muted',
        'accent',
        'destructive',
        'border',
        'input',
        'ring',
        'sidebar',
        'sidebar-foreground',
    ];

    for (const token of tokenNames) {
        assert.match(rootBlock, new RegExp(`--${token}:`), `라이트 --${token} 누락`);
        assert.match(darkBlock, new RegExp(`--${token}:`), `다크 --${token} 누락`);
    }
    assert.match(rootBlock, /color-scheme:\s*light/);
    assert.match(darkBlock, /color-scheme:\s*dark/);
});

test('버튼과 알림은 공통 variant를 제공하고 화면은 이를 조합한다', () => {
    const button = source('./components/ui/button.tsx');
    const alert = source('./components/ui/alert.tsx');
    const asyncState = source('./components/dashboard/async-state.tsx');

    assert.match(button, /const buttonVariants = cva\(/);
    for (const variant of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
        assert.match(button, new RegExp(`${variant}:`));
    }
    assert.match(alert, /const alertVariants = cva\(/);
    assert.match(asyncState, /<Alert variant="destructive">/);
    assert.match(asyncState, /export function (?:LoadingState|ErrorState|EmptyState)/);
});

test('공통 상호작용 컴포넌트는 키보드 포커스와 비활성 상태를 시각화한다', () => {
    for (const path of ['./components/ui/button.tsx', './components/ui/input.tsx', './components/ui/switch.tsx']) {
        const component = source(path);
        assert.match(component, /focus-visible:/, `${path}에 키보드 포커스 스타일이 없습니다.`);
        assert.match(component, /disabled:/, `${path}에 disabled 스타일이 없습니다.`);
    }
    assert.match(globals, /outline-ring\/50/);
    assert.match(source('./app/shell/DashboardShell.tsx'), /focus-visible:ring-2/);
});

test('README 트레이 아이콘은 런타임과 같이 나침반 바깥의 배경 박스를 채운다', () => {
    for (const status of ['normal', 'offline', 'warning', 'alert', 'complete']) {
        const icon = source(`../docs/assets/readme/readme-status-${status}.svg`);

        assert.match(icon, /<mask id="compass-field"/);
        assert.match(icon, /<circle cx="22" cy="22" r="16" fill="black"/);
        assert.match(icon, /width="38" height="38"[^>]*fill="currentColor"[^>]*mask="url\(#compass-field\)"/);
        assert.match(icon, /<rect x="3" y="3" width="38" height="38" rx="10" fill="none"/);
        assert.match(icon, /stroke="currentColor" stroke-width="1\.6"/);
        assert.match(icon, /M512 896a384 384 0 1 0 0-768/);
        assert.match(icon, /M725\.888 315\.008C676\.48 428\.672/);
        assert.match(icon, /translate\(3\.5 3\.5\) scale\(\.0361328125\)/);
    }
});
