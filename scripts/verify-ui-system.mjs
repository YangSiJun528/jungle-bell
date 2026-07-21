import {existsSync, readFileSync} from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const uiCss = read('../src/ui.css');
const stylesCss = read('../src/styles.css');
const settingsHtml = read('../src/index.html');
const onboardingHtml = read('../src/onboarding.html');
const campusHtml = read('../src/campus.html');
const campusTs = read('../src/campus.ts');
const infoDisclosureTs = read('../src/info-disclosure.ts');
const trayRust = read('../src-tauri/src/tray.rs');
const htmlFiles = [
    ['index.html', settingsHtml],
    ['onboarding.html', onboardingHtml],
    ['campus.html', campusHtml],
];
const errors = [];
const requireRule = (condition, message) => { if (!condition) errors.push(message); };

// The externally managed sanitize block and the small authored base layer must remain present.
requireRule(stylesCss.includes('!! SANITIZE.CSS — DO NOT EDIT !!')
    && stylesCss.includes('BEGIN-SANITIZE')
    && stylesCss.includes('END-SANITIZE'), 'The managed sanitize.css block is missing or its boundary changed');
requireRule(/\*,\s*\n::before,\s*\n::after\s*\{[^}]*box-sizing:\s*border-box;/s.test(stylesCss), 'Global border-box sizing is missing');
requireRule(stylesCss.includes('@font-face') && stylesCss.includes('PretendardVariable.woff2'), 'Bundled Pretendard @font-face is missing');
requireRule(stylesCss.includes('--font-family: "Pretendard", sans-serif;'), 'Pretendard must remain the exclusive UI font');
requireRule(existsSync(new URL('../src/assets/fonts/Pretendard-LICENSE.txt', import.meta.url)), 'Pretendard license is missing');

// Tailwind is the layout system. Only the explicitly permitted repeated patterns stay components.
requireRule(uiCss.includes('@import "tailwindcss/utilities.css" layer(utilities);'), 'Tailwind utilities are not imported');
const componentStart = uiCss.indexOf('@layer components {');
const componentEnd = uiCss.indexOf('\n@media (prefers-reduced-motion', componentStart);
const componentCss = componentStart >= 0 && componentEnd >= 0 ? uiCss.slice(componentStart, componentEnd) : '';
const allowedComponents = new Set(['ui-button', 'ui-tab', 'ui-tooltip', 'ui-tooltip-popover']);
for (const match of componentCss.matchAll(/\.(ui-[\w-]+)/g)) {
    if (!allowedComponents.has(match[1])) errors.push(`Unexpected component class remains in @layer components: ${match[1]}`);
}
const legacyUiClass = /\bui-(?:page|shell|app-header|app-logo|page-heading|section-heading|settings|setting|action-row|field|select|choice|footer|info|alert|empty|content|spinner|eyebrow|note|state|onboarding)/;
for (const [name, source] of htmlFiles) {
    requireRule(!legacyUiClass.test(source), `src/${name} still uses a legacy ui-* layout class`);
}
requireRule(!/\.(?:laundry-grid|laundry-card|meal-card|meal-calendar|onboarding-panel)\s*\{/.test(uiCss), 'Page layout CSS must live in Tailwind utilities, not named selectors');

// Global visual constraints.
requireRule(!/@media\s*\(max-(?:width|height):/.test(uiCss), 'Fixed-size windows must not use viewport breakpoints');
requireRule(!/transition\s*:\s*all\b/.test(uiCss), 'transition: all is forbidden');
requireRule(!/#[0-9a-f]{3,8}\b/i.test(uiCss), 'ui.css contains a hardcoded hex color');
requireRule(!/letter-spacing\s*:\s*-|tracking-\[\s*-/.test(`${uiCss}\n${htmlFiles.map(([, source]) => source).join('\n')}`), 'Negative letter spacing is forbidden');
requireRule(!/rounded-(?:xl|2xl|3xl)/.test(htmlFiles.map(([, source]) => source).join('\n')), 'Cards and dialogs must not exceed an 8px radius');
requireRule(!/--radius-(?:card|dialog)/.test(uiCss), 'Legacy card/dialog radius tokens must be removed');
requireRule(/html\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable/s.test(uiCss), 'Stable root scrollbar layout is missing');
requireRule(/\*::\-webkit-scrollbar-thumb/.test(uiCss) && /scrollbar-width:\s*thin/.test(uiCss), 'Thin macOS-style scrollbar rules are missing');

const spacingTokens = new Map([
    ['--space-0', 0], ['--space-half', 2], ['--space-1', 4], ['--space-2', 8],
    ['--space-4', 16], ['--space-6', 24], ['--space-8', 32], ['--space-12', 48],
    ['--space-16', 64], ['--space-24', 96],
]);
for (const [token, value] of spacingTokens) requireRule(uiCss.includes(`${token}: ${value}px;`), `Spacing token ${token} is missing`);
const spacingProperty = /^(?:margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height)$/;
const approvedPixels = new Set([0, 2, 4, 8, 16, 24, 32, 48, 64, 96, 9998]);
for (const declaration of uiCss.matchAll(/([-\w]+)\s*:\s*([^;}{]+)/g)) {
    if (!spacingProperty.test(declaration[1])) continue;
    for (const match of declaration[2].matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        if (!approvedPixels.has(Math.abs(Number(match[1])))) errors.push(`src/ui.css uses off-scale fixed size ${match[0]} in ${declaration[1]}`);
    }
}

// Shared interaction primitives.
for (const selector of [':hover', ':active', ':focus-visible', ':disabled', '[aria-current="page"]']) {
    requireRule(uiCss.includes(selector), `Required interaction state ${selector} is missing`);
}
for (const [name, source] of htmlFiles) {
    const selects = source.match(/<select\b/g) ?? [];
    const hiddenSelects = source.match(/<select\s+hidden\b/g) ?? [];
    const comboboxes = source.match(/role="combobox"\s+aria-haspopup="listbox"/g) ?? [];
    requireRule(selects.length === hiddenSelects.length, `src/${name} contains a visible native select`);
    requireRule(selects.length === comboboxes.length, `src/${name} has a custom select without combobox/listbox semantics`);
}
requireRule(/\.ui-switch::after/.test(uiCss) && /\.ui-progress::\-webkit-progress-value/.test(uiCss), 'Native switch/progress pseudo-element styling is missing');

// Settings hierarchy and semantics.
requireRule(/<nav[^>]*aria-label="설정 분류"/.test(settingsHtml), 'Settings tabs need a labelled nav');
requireRule((settingsHtml.match(/<fieldset\b/g) ?? []).length >= 6 && (settingsHtml.match(/<legend\b/g) ?? []).length >= 6, 'Settings groups must use fieldset/legend');
requireRule(settingsHtml.includes('text-base') && settingsHtml.includes('text-sm') && settingsHtml.includes('text-xs'), 'Settings text hierarchy is incomplete');
requireRule(settingsHtml.includes('<details class="group') && settingsHtml.includes('온보딩 다시 보기'), 'Advanced diagnostics and onboarding action are missing');
requireRule(/data-variant="text"/.test(settingsHtml), 'Settings text actions must use content-sized buttons');

// Onboarding fixed skeleton and persistent actions.
requireRule(onboardingHtml.includes('class="h-screen overflow-hidden') && onboardingHtml.includes('class="min-h-0 flex-1 overflow-hidden'), 'Onboarding must use a fixed non-scrolling frame');
requireRule((onboardingHtml.match(/x-show="step === \d"/g) ?? []).length === 6, 'All six onboarding steps must remain present');
requireRule(/<progress[^>]*aria-label="온보딩 진행률"/.test(onboardingHtml), 'Onboarding progress must use a labelled progress element');
requireRule(/<footer class="grid min-h-12 flex-none grid-cols-3/.test(onboardingHtml), 'Onboarding actions must remain fixed below the step panel');

// Laundry structure, filtering, colors, fixed card geometry, and disclosures.
requireRule(campusHtml.includes('grid grid-cols-3 items-start gap-4'), 'Laundry cards must remain a three-column grid');
requireRule(campusHtml.includes('grid-rows-[32px_96px_96px]'), 'Laundry cards must keep fixed header/appliance geometry');
requireRule(/<table class="w-full table-fixed border-separate[^>]*>[\s\S]*?<caption class="sr-only">워시타워 번호별/s.test(campusHtml), 'Laundry overview must remain a semantic table');
requireRule(campusHtml.includes("x-model=\"laundryAccess\"") && campusHtml.includes("x-model=\"laundryFilter\""), 'Laundry filter bindings are missing');
for (const zone of ['men', 'common', 'women']) requireRule(campusHtml.includes(`bg-app-${zone}`), `Laundry ${zone} color is missing`);
requireRule(campusHtml.includes("filteredMachines().length === 0") && campusHtml.includes('laundryEmptyMessage()'), 'Laundry filtered empty state is missing');
requireRule((campusHtml.match(/x-data="infoDisclosure"/g) ?? []).length >= 2
    && campusHtml.includes('@keydown.escape.stop="dismiss()"')
    && campusHtml.includes('@focusin="focus()"')
    && campusHtml.includes('x-anchor.fixed.offset.8="$refs.trigger"'), 'Information tooltips must support focus, keyboard dismissal, and viewport anchoring');
requireRule(/\.ui-tooltip-popover\s*\{[^}]*position:\s*fixed[^}]*max-height:\s*calc\(100vh - var\(--space-6\)\)[^}]*word-break:\s*keep-all/s.test(uiCss), 'Tooltip popovers must stay inside the viewport and preserve Korean words');
requireRule(infoDisclosureTs.includes("const OPEN_EVENT = 'info-disclosure-open'") && infoDisclosureTs.includes('handlePeer(event:'), 'Shared information disclosure behavior is missing');

// Meal tabs, calendar, empty/error states, and dialog restoration.
requireRule(/<nav[^>]*aria-label="급식 보기">[\s\S]*?>식단<\/button>[\s\S]*?>내역<\/button>/s.test(campusHtml), 'Meal tabs must retain 식단 and 내역');
requireRule(/<table[^>]*aria-labelledby="meal-calendar-title">[\s\S]*?<caption class="sr-only"[^>]*급식 달력/s.test(campusHtml), 'Meal calendar must be a labelled table');
requireRule(campusHtml.includes("['일', '월', '화', '수', '목', '금', '토']") && campusHtml.includes('table-fixed'), 'Meal calendar must keep seven fixed columns');
requireRule(campusHtml.includes('이번 주 식단표가 아직 게시되지 않았습니다.') && campusHtml.includes('이 주차에 저장된 식단표가 없습니다.'), 'Weekly meal empty states are missing');
requireRule(/<dialog class="image-dialog/.test(campusHtml) && campusHtml.includes('@cancel.prevent="closeImage'), 'Meal image viewer must use dialog with Escape handling');
requireRule(campusTs.includes('imageDialogScroll = {left: window.scrollX, top: window.scrollY}')
    && campusTs.includes('trigger?.focus({preventScroll: true})')
    && campusTs.includes('window.scrollTo(scroll.left, scroll.top)'), 'Image dialog must restore trigger focus and scroll position');

// Loading/error states, footer, and immutable window contracts.
requireRule((campusHtml.match(/@click="retry\(\)"/g) ?? []).length === 2 && !campusHtml.includes('@click="refresh()"'), 'Campus retry controls must remain error-only');
for (const [, source] of htmlFiles) requireRule(source.includes('aria-live="polite"') || source === onboardingHtml, 'Live loading/status feedback is missing');
requireRule(settingsHtml.includes('aria-label="프로젝트 링크"') && campusHtml.includes('aria-label="프로젝트 링크"'), 'Shared project footer links are missing');
requireRule(/const UTILITY_WINDOW_WIDTH:\s*f64\s*=\s*560\.0;/.test(trayRust)
    && /const CONTENT_WINDOW_WIDTH:\s*f64\s*=\s*720\.0;/.test(trayRust)
    && /const STANDARD_WINDOW_HEIGHT:\s*f64\s*=\s*720\.0;/.test(trayRust)
    && /const ATTENDANCE_MIN_SIZE:\s*f64\s*=\s*640\.0;/.test(trayRust), 'Window size constants must remain 560/720/640');
requireRule(/fn build_campus_window[\s\S]*?\.inner_size\(CONTENT_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)[\s\S]*?\.resizable\(false\)/s.test(trayRust), 'Campus window must remain fixed at 720x720');
requireRule(/fn build_settings_window[\s\S]*?\.inner_size\(UTILITY_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)[\s\S]*?\.resizable\(false\)/s.test(trayRust), 'Settings window must remain fixed at 560x720');
requireRule(/fn build_onboarding_window[\s\S]*?\.inner_size\(UTILITY_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)[\s\S]*?\.resizable\(false\)/s.test(trayRust), 'Onboarding window must remain fixed at 560x720');
requireRule(/fn build_attendance_window[\s\S]*?\.inner_size\(CONTENT_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)[\s\S]*?\.min_inner_size\(ATTENDANCE_MIN_SIZE, ATTENDANCE_MIN_SIZE\)[\s\S]*?\.resizable\(true\)/s.test(trayRust), 'Attendance window size contract changed');

if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log('UI system verification passed.');
}
