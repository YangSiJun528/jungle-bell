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

// Tailwind utilities and adapted Pines markup are the complete component/layout system.
requireRule(uiCss.includes('@import "tailwindcss/utilities.css" layer(utilities);'), 'Tailwind utilities are not imported');
requireRule(!uiCss.includes('@layer components'), 'Custom component CSS must not be reintroduced');
const legacyUiClass = /\bui-[\w-]+/;
for (const [name, source] of htmlFiles) {
    requireRule(!legacyUiClass.test(source), `src/${name} still uses a custom ui-* class`);
}
requireRule(!/\.(?:ui-|laundry-|meal-|onboarding-)[\w-]*\s*(?:[,{:]|::)/.test(uiCss), 'Component/page selectors must live in Tailwind markup');

// Global visual constraints.
requireRule(!/@media\s*\(max-(?:width|height):/.test(uiCss), 'Fixed-size windows must not use viewport breakpoints');
requireRule(!/transition\s*:\s*all\b/.test(uiCss), 'transition: all is forbidden');
requireRule(!/#[0-9a-f]{3,8}\b/i.test(uiCss), 'ui.css contains a hardcoded hex color');
requireRule(!/letter-spacing\s*:\s*-|tracking-\[\s*-/.test(`${uiCss}\n${htmlFiles.map(([, source]) => source).join('\n')}`), 'Negative letter spacing is forbidden');
requireRule(!/rounded-(?:xl|2xl|3xl)/.test(htmlFiles.map(([, source]) => source).join('\n')), 'Cards and dialogs must not exceed an 8px radius');
requireRule(!/--radius-(?:card|dialog)/.test(uiCss), 'Legacy card/dialog radius tokens must be removed');
requireRule(/html\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable/s.test(uiCss), 'Stable root scrollbar layout is missing');
requireRule(/\*::\-webkit-scrollbar-thumb/.test(uiCss) && /scrollbar-width:\s*thin/.test(uiCss), 'Thin macOS-style scrollbar rules are missing');

const spacingProperty = /^(?:margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height)$/;
const approvedPixels = new Set([0, 2, 4, 8, 16, 24, 32, 48, 64, 96, 9998]);
for (const declaration of uiCss.matchAll(/([-\w]+)\s*:\s*([^;}{]+)/g)) {
    if (!spacingProperty.test(declaration[1])) continue;
    for (const match of declaration[2].matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        if (!approvedPixels.has(Math.abs(Number(match[1])))) errors.push(`src/ui.css uses off-scale fixed size ${match[0]} in ${declaration[1]}`);
    }
}

// Pines-style controls stay in markup and retain the app's stronger semantics.
const allHtml = htmlFiles.map(([, source]) => source).join('\n');
for (const utility of ['hover:', 'focus-visible:', 'disabled:', 'aria-[current=page]:']) {
    requireRule(allHtml.includes(utility), `Required Tailwind interaction utility ${utility} is missing`);
}
for (const [name, source] of htmlFiles) {
    const selects = source.match(/<select\b/g) ?? [];
    const hiddenSelects = source.match(/<select\s+hidden\b/g) ?? [];
    const comboboxes = source.match(/role="combobox"\s+aria-haspopup="listbox"/g) ?? [];
    requireRule(selects.length === hiddenSelects.length, `src/${name} contains a visible native select`);
    requireRule(selects.length === comboboxes.length, `src/${name} has a custom select without combobox/listbox semantics`);
}
for (const [name, source] of [['index.html', settingsHtml], ['onboarding.html', onboardingHtml]]) {
    const checkboxes = source.match(/type="checkbox"/g) ?? [];
    const pinesSwitches = source.match(/class="peer sr-only" type="checkbox"/g) ?? [];
    requireRule(checkboxes.length === pinesSwitches.length, `src/${name} has a checkbox outside the Pines switch pattern`);
}
requireRule(allHtml.includes('peer-checked:translate-x-6')
    && allHtml.includes('peer-focus-visible:ring-4'), 'Pines switches need track/thumb and keyboard focus states');
requireRule(/<progress[^>]*\[&::\-webkit-progress-value\]:bg-app-accent/.test(onboardingHtml)
    && /<progress[^>]*\[&::\-moz-progress-bar\]:bg-app-accent/.test(campusHtml), 'Progress elements must use Tailwind vendor pseudo-element utilities');

// Settings hierarchy and semantics.
requireRule(/<nav[^>]*aria-label="설정 분류"/.test(settingsHtml), 'Settings tabs need a labelled nav');
requireRule((settingsHtml.match(/<fieldset\b/g) ?? []).length >= 6 && (settingsHtml.match(/<legend\b/g) ?? []).length >= 6, 'Settings groups must use fieldset/legend');
requireRule(settingsHtml.includes('text-base') && settingsHtml.includes('text-sm') && settingsHtml.includes('text-xs'), 'Settings text hierarchy is incomplete');
requireRule(settingsHtml.includes('<details class="group') && settingsHtml.includes('온보딩 다시 보기'), 'Advanced diagnostics and onboarding action are missing');
requireRule(settingsHtml.includes('hover:bg-app-accent-soft') && !settingsHtml.includes('data-variant='), 'Settings text actions must use direct Pines/Tailwind button utilities');

// Onboarding fixed skeleton and persistent actions.
requireRule(onboardingHtml.includes('class="h-screen overflow-hidden') && onboardingHtml.includes('class="min-h-0 flex-1 overflow-hidden'), 'Onboarding must use a fixed non-scrolling frame');
requireRule((onboardingHtml.match(/x-show="step === \d"/g) ?? []).length === 6, 'All six onboarding steps must remain present');
requireRule(/<progress[^>]*aria-label="온보딩 진행률"/.test(onboardingHtml), 'Onboarding progress must use a labelled progress element');
requireRule(/<footer class="grid min-h-12 flex-none grid-cols-3/.test(onboardingHtml), 'Onboarding actions must remain fixed below the step panel');

// Laundry structure, filtering, colors, fixed card geometry, and disclosures.
requireRule(campusHtml.includes('grid grid-cols-3 items-start gap-4'), 'Laundry cards must remain a three-column grid');
requireRule(campusHtml.includes('grid-rows-[32px_96px_96px]'), 'Laundry cards must keep fixed header/appliance geometry');
requireRule(/<table class="w-full table-fixed border-separate[^>]*>[\s\S]*?<caption class="sr-only">워시타워 번호별/s.test(campusHtml), 'Laundry overview must remain a semantic table');
requireRule(campusTs.includes('laundryOverviewText(appliance, this.clockNow)')
    && campusHtml.includes('x-text="segment.overviewText"')
    && campusHtml.includes("'border-app-border bg-app-faint': segment.state !== 'available'")
    && !campusHtml.includes("'border-app-danger bg-app-danger': segment.state === 'error'"), 'Laundry overview must preserve available zone colors and use gray cells for remaining time or ERROR');
requireRule(campusTs.includes('laundryRemainingText(appliance, this.clockNow)')
    && campusTs.includes('laundryOperationLabel(appliance)')
    && campusHtml.includes('x-show="startAt(entry.appliance)"')
    && campusHtml.includes(' 시작`')
    && campusHtml.includes(' 종료`'), 'Laundry cards must show concrete states, available wording, and start/end times');
requireRule(campusHtml.includes("x-model=\"laundryAccess\"") && campusHtml.includes("x-model=\"laundryFilter\""), 'Laundry filter bindings are missing');
for (const zone of ['men', 'common', 'women']) requireRule(campusHtml.includes(`bg-app-${zone}`), `Laundry ${zone} color is missing`);
requireRule(campusHtml.includes("filteredMachines().length === 0") && campusHtml.includes('laundryEmptyMessage()'), 'Laundry filtered empty state is missing');
requireRule((campusHtml.match(/x-data="infoDisclosure"/g) ?? []).length >= 2
    && campusHtml.includes('@keydown.escape.stop="dismiss()"')
    && campusHtml.includes('@focusin="focus()"')
    && campusHtml.includes('x-anchor.fixed.bottom-end.offset.16="$refs.trigger"'), 'Information tooltips must support focus, keyboard dismissal, and inward viewport anchoring');
requireRule(campusHtml.includes('fixed z-40 max-h-[calc(100vh-32px)] w-[min(40vw,calc(100vw-32px))]')
    && campusHtml.includes('[word-break:keep-all]')
    && campusHtml.includes('x-transition:enter="transition ease-out duration-200"'), 'Pines tooltips must stay inside the viewport, animate, and preserve Korean words');
requireRule(/<aside class="[^"]*pr-2[^"]*"[^>]*:data-tone="sourceView\(activeTab\)\.tone"/.test(campusHtml), 'Header information control must keep extra distance from the scrollbar edge');
requireRule(campusTs.includes('window.setInterval(() =>')
    && campusTs.includes('this.clockNow = Date.now()')
    && campusTs.includes('window.clearInterval(this.clockTimer)'), 'Campus relative times and laundry countdown must use a cleaned-up live UI clock');
requireRule(campusHtml.includes('aria-label="세탁기 현황 불러오는 중"')
    && campusHtml.includes('x-show="!laundry && !errors.laundry"')
    && campusHtml.includes('data-skeleton="laundry"'), 'Laundry loading must use a dedicated skeleton that disappears on errors');
requireRule(campusHtml.includes('aria-label="식단 불러오는 중"')
    && campusHtml.includes('x-show="!meals && !errors.meals"')
    && campusHtml.includes('data-skeleton="meals"'), 'Meal loading must use a dedicated skeleton that disappears on errors');
requireRule((campusHtml.match(/animate-pulse motion-reduce:animate-none/g) ?? []).length >= 2,
    'Campus skeletons must animate with reduced-motion support');
requireRule(campusTs.includes("window.addEventListener('online', this.onlineRecoveryHandler)")
    && campusTs.includes('this.recoveryTimer = window.setInterval')
    && campusTs.includes("window.removeEventListener('online', this.onlineRecoveryHandler)")
    && campusTs.includes('window.clearInterval(this.recoveryTimer)'),
    'Campus loading must retry after network recovery and clean up its recovery hooks');
requireRule(infoDisclosureTs.includes("const OPEN_EVENT = 'info-disclosure-open'") && infoDisclosureTs.includes('handlePeer(event:'), 'Shared information disclosure behavior is missing');

// Meal tabs, calendar, empty/error states, and dialog restoration.
requireRule(/<nav[^>]*aria-label="급식 보기">[\s\S]*?>식단<\/button>[\s\S]*?>내역<\/button>/s.test(campusHtml), 'Meal tabs must retain 식단 and 내역');
requireRule(campusHtml.includes('class="grid grid-cols-2 gap-4" x-show="mealsServedToday()"'), 'Today lunch and dinner cards must keep the compact 16px gap');
requireRule((campusHtml.match(/break-normal whitespace-pre-line[^>]*x-text="[^"]*메뉴 내용이 없습니다/g) ?? []).length === 2,
    'Meal menu text must use normal line breaking for comma-separated menus');
requireRule(/<table[^>]*aria-labelledby="meal-calendar-title">[\s\S]*?<caption class="sr-only"[^>]*급식 달력/s.test(campusHtml), 'Meal calendar must be a labelled table');
requireRule(campusHtml.includes("['일', '월', '화', '수', '목', '금', '토']") && campusHtml.includes('table-fixed'), 'Meal calendar must keep seven fixed columns');
requireRule((campusTs.match(/sortMealPostsByPeriod\(/g) ?? []).length >= 2, 'Calendar meal indicators and selected posts must sort lunch before dinner');
requireRule(campusHtml.includes('이번 주 식단표가 아직 게시되지 않았습니다.') && campusHtml.includes('이 주차에 저장된 식단표가 없습니다.'), 'Weekly meal empty states are missing');
requireRule(/<dialog class="[^"]*backdrop:bg-app-shade/.test(campusHtml) && campusHtml.includes('@cancel.prevent="closeImage'), 'Meal image viewer must use a Tailwind-styled dialog with Escape handling');
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
