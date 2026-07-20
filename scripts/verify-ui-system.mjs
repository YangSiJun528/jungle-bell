import {existsSync, readFileSync} from 'node:fs';

const spacingTokens = new Map([
    ['--space-0', 0],
    ['--space-half', 2],
    ['--space-1', 4],
    ['--space-2', 8],
    ['--space-4', 16],
    ['--space-6', 24],
    ['--space-8', 32],
    ['--space-12', 48],
    ['--space-16', 64],
    ['--space-24', 96],
]);
const approvedSpacing = new Set(spacingTokens.values());
const uiCss = readFileSync(new URL('../src/ui.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const campusTs = readFileSync(new URL('../src/campus.ts', import.meta.url), 'utf8');
const infoDisclosureTs = readFileSync(new URL('../src/info-disclosure.ts', import.meta.url), 'utf8');
const trayRust = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');
const htmlFiles = ['index.html', 'onboarding.html', 'campus.html'].map((name) => ({
    name,
    source: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
}));
const settingsHtml = htmlFiles.find(({name}) => name === 'index.html')?.source ?? '';
const campusHtml = htmlFiles.find(({name}) => name === 'campus.html')?.source ?? '';
const authoredStylesCss = stylesCss.split('END-SANITIZE')[1] ?? '';

const errors = [];
const spacingProperty = /^(?:margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|inset|top|right|bottom|left)$/;

for (const declaration of uiCss.matchAll(/([-\w]+)\s*:\s*([^;}{]+)/g)) {
    const [, property, valueSource] = declaration;
    if (!spacingProperty.test(property)) continue;
    for (const match of valueSource.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        const value = Number(match[1]);
        if (!approvedSpacing.has(Math.abs(value))) {
            const line = uiCss.slice(0, declaration.index).split('\n').length;
            errors.push(`src/ui.css:${line} uses off-scale spacing ${match[0]} in ${property}: ${valueSource.trim()}`);
        }
    }
}

for (const [token, value] of spacingTokens) {
    if (!uiCss.includes(`${token}: ${value}px;`)) errors.push(`Spacing token ${token}: ${value}px is missing from src/ui.css`);
}
if (uiCss.includes('--space-3')) errors.push('The off-scale 12px spacing token must not be used');

for (const [name, source] of [['src/ui.css', uiCss], ['src/styles.css', authoredStylesCss]]) {
    for (const [index, line] of source.split('\n').entries()) {
        for (const match of line.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
            const value = Number(match[1]);
            const isBorderToken = name === 'src/ui.css' && line.includes('--border-width: 1px');
            if (Math.abs(value) % 2 !== 0 && !isBorderToken) {
                errors.push(`${name}:${index + 1} uses an odd pixel value ${match[0]} in: ${line.trim()}`);
            }
        }
    }
}

if (!uiCss.includes('--border-width: 1px;')
    || /border(?:-(?:top|right|bottom|left))?:\s*1px/.test(uiCss)) {
    errors.push('One-pixel borders must use the shared border-width token');
}
if (!/\*,\s*\n::before,\s*\n::after\s*\{[^}]*box-sizing:\s*border-box;/s.test(stylesCss)) {
    errors.push('Global border-box sizing must keep one-pixel borders inside even component dimensions');
}

if (/transition\s*:\s*all\b/.test(uiCss)) errors.push('transition: all is forbidden');
if (/#[0-9a-f]{3,8}\b/i.test(uiCss)) errors.push('src/ui.css contains a hardcoded hex color');
if (!/html\s*\{[^}]*background:\s*var\(--color-bg\)/s.test(uiCss)
    || !/\*::\-webkit-scrollbar-corner\s*\{[^}]*background:\s*var\(--color-bg\)/s.test(uiCss)) {
    errors.push('The root canvas and scrollbar corner must share the app background');
}
if (!stylesCss.includes('@font-face') || !stylesCss.includes('PretendardVariable.woff2')) errors.push('Bundled Pretendard @font-face is missing');
if (!stylesCss.includes('--font-family: "Pretendard", sans-serif;')) errors.push('Pretendard is not the exclusive UI font family');
if (!existsSync(new URL('../src/assets/fonts/Pretendard-LICENSE.txt', import.meta.url))) errors.push('Pretendard license is missing from the font assets');

for (const {name, source} of htmlFiles) {
    for (const match of source.matchAll(/<select\b[^>]*>/g)) {
        if (!/\shidden(?:\s|>)/.test(match[0])) errors.push(`src/${name} contains a visible native select: ${match[0]}`);
    }
    const triggerCount = (source.match(/class="ui-select-trigger"/g) ?? []).length;
    const comboboxCount = (source.match(/class="ui-select-trigger" role="combobox" aria-haspopup="listbox"/g) ?? []).length;
    if (triggerCount !== comboboxCount) errors.push(`src/${name} has a select trigger without combobox/listbox semantics`);
}

const requiredStateSelectors = [':hover', ':active', ':focus-visible', ':disabled', '[aria-selected="true"]', '[aria-current="page"]'];
for (const selector of requiredStateSelectors) {
    if (!uiCss.includes(selector)) errors.push(`Required interaction state ${selector} is missing`);
}

if (!/<nav class="ui-tabs sub-tabs" aria-label="급식 보기">[\s\S]*?>식단<\/button>[\s\S]*?>내역<\/button>/s.test(campusHtml)
    || campusHtml.includes('오늘·이번 주')
    || campusHtml.includes('지난 식단')) {
    errors.push('Meal sub-tabs must use the concise 식단 and 내역 labels');
}
if (!/machineName\(id:\s*string\)[\s\S]*?return number !== null \? `\$\{number\}번`/s.test(campusTs)) {
    errors.push('Wash-tower cards must use number-only titles within the titled directory');
}

if (!/\.laundry-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*gap:\s*var\(--space-4\)/s.test(uiCss)) {
    errors.push('The default wash-tower grid must show three columns');
}
if (!/<ul class="availability-key" aria-label="사용 가능한 구역과 이용 중 상태 색상">[\s\S]*?data-zone="men"[\s\S]*?data-zone="common"[\s\S]*?data-zone="women"[\s\S]*?<li data-state="unavailable"><i><\/i>이용 중<\/li>/s.test(campusHtml)
    || campusHtml.includes('>사용 불가<')
    || !/<section class="laundry-directory" aria-labelledby="laundry-title">[\s\S]*?<div class="laundry-overview" :data-access="laundryAccess" :data-filter="laundryFilter">[\s\S]*?<header class="ui-section-heading laundry-heading">\s*<h2 id="laundry-title">워시타워<\/h2>/s.test(campusHtml)
    || campusHtml.includes('<p>번호별 세탁기·건조기 사용 가능 현황</p>')
    || campusHtml.includes('laundry-overview-title')
    || campusHtml.includes('>현재 사용 현황<')
    || !/<table class="availability-layout">[\s\S]*?<caption class="sr-only">[\s\S]*?row in \[\{kind:'dryer', label:'건조기'\}, \{kind:'washer', label:'세탁기'\}\]/s.test(campusHtml)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="men"\] \.availability-tower-state[^}]*background:\s*var\(--color-men\)/s.test(uiCss)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="common"\] \.availability-tower-state[^}]*background:\s*var\(--color-common\)/s.test(uiCss)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="women"\] \.availability-tower-state[^}]*background:\s*var\(--color-women\)/s.test(uiCss)
    || !/\.availability-tower-state\s*\{[^}]*background:\s*var\(--color-text-faint\)/s.test(uiCss)
    || !/\.laundry-overview\[data-access="men"\][^{]*\[data-zone="women"\][\s\S]*?\.laundry-overview\[data-access="women"\][^{]*\[data-zone="men"\][^}]*filter:\s*blur\(2px\)[^}]*opacity:\s*0\.24/s.test(uiCss)
    || !/\.laundry-overview\[data-filter="washerAvailable"\][^{]*\[data-kind="dryer"\][\s\S]*?\.laundry-overview\[data-filter="dryerAvailable"\][^{]*\[data-kind="washer"\][^}]*filter:\s*blur\(2px\)[^}]*opacity:\s*0\.24/s.test(uiCss)
    || /availability-layout td\[data-state="error"\][^}]*var\(--color-danger\)/s.test(uiCss)
    || campusHtml.includes('availability-progress') || uiCss.includes('.availability-segments')) {
    errors.push('Laundry overview must mirror the 1-9 tower layout and use zone colors only for available appliances');
}
if (!/<header class="ui-app-header campus-header">[\s\S]*?<aside class="header-source-state"\s+:data-tone="source\[activeTab\]\.tone"/s.test(campusHtml)
    || /<header class="source-state"/.test(campusHtml)
    || !/<details class="ui-info header-source-info"[^>]*x-data="infoDisclosure"[^>]*>[\s\S]*?<summary[^>]*@click\.prevent="toggle\(\)"[^>]*>i<\/summary>/s.test(campusHtml)
    || !/\.header-source-state\s*\{[^}]*width:\s*240px[^}]*min-height:\s*var\(--space-12\)/s.test(uiCss)
    || !/\.campus-tabs\s*\{[^}]*margin-bottom:\s*var\(--space-4\)/s.test(uiCss)) {
    errors.push('Laundry and meal freshness must share the compact campus header status');
}
if (campusHtml.includes('refresh-button') || campusHtml.includes('@click="refresh()"')
    || !campusHtml.includes('@click="retry()"') || !campusTs.includes('async retry(this: any)')) {
    errors.push('Scheduled campus updates must not expose a manual refresh; retry is reserved for load failures');
}
if (!/completionConfirmationDelayed[\s\S]*?Date\.now\(\) > finishAt\.getTime\(\)/s.test(campusTs)
    || !/status === 'AWAITING_COMPLETION_CONFIRMATION'[\s\S]*?\? \{label: '완료 확인 지연', tone: 'warning'\}[\s\S]*?: \{label: '작동 중', tone: 'normal'\}/s.test(campusTs)
    || campusTs.includes('COMPLETION_CONFIRMATION_GRACE_MS')
    || campusTs.includes('freshnessView(')
    || !/label: this\.laundry\.quality\?\.lastCheckedAt[\s\S]*?`\$\{this\.relativeTime\([^)]*\)\} 갱신`/s.test(campusTs)) {
    errors.push('Campus freshness must stay neutral and completion delay must begin immediately after the estimated finish time');
}
if (!infoDisclosureTs.includes("const OPEN_EVENT = 'info-disclosure-open'")
    || !infoDisclosureTs.includes("const DISMISS_EVENT = 'info-disclosure-dismiss'")
    || !/get visible\(\)[\s\S]*?this\.pinned/s.test(infoDisclosureTs)
    || !/handlePeer[\s\S]*?event\.detail === this\.id/s.test(infoDisclosureTs)) {
    errors.push('Information disclosures must share one Alpine interaction model');
}
const disclosureBindings = campusHtml.match(/x-data="infoDisclosure"/g) ?? [];
if (disclosureBindings.length < 2
    || !campusHtml.includes('@mouseenter="enter()"')
    || !campusHtml.includes('@focusin="focus()"')
    || !campusHtml.includes('@keydown.escape.stop="dismiss()"')
    || !campusHtml.includes('@click.outside="dismiss()"')
    || !campusHtml.includes('@info-disclosure-open.window="handlePeer($event)"')) {
    errors.push('Header and appliance disclosures must support hover, focus, pinning, Escape, and mutual exclusion');
}
if (/@media[^{]*\{[\s\S]*?\.laundry-grid\s*\{/s.test(uiCss)) {
    errors.push('The fixed-size wash-tower window must keep a three-column grid');
}
if (/@media\s*\(max-(?:width|height):/s.test(uiCss)) {
    errors.push('Fixed-size app windows must not use viewport layout breakpoints');
}
if (!/\.laundry-card\s*\{[^}]*height:\s*208px[^}]*grid-template-rows:\s*var\(--space-8\)\s+minmax\(0,\s*1fr\)/s.test(uiCss)
    || campusHtml.includes('appliance-error') || uiCss.includes('.appliance-error')
    || !/<div class="appliance-status">[\s\S]*?<span class="status-badge"[\s\S]*?<details class="ui-info appliance-info"/s.test(campusHtml)) {
    errors.push('Wash-tower cards must keep fixed geometry and place explanations beside the status badge');
}
if (!/\.ui-info summary\s*\{[^}]*width:\s*var\(--space-6\)[^}]*height:\s*var\(--space-6\)/s.test(uiCss)
    || !/\.ui-info-popover\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*40[^}]*max-height:\s*calc\(100vh - var\(--space-6\)\)[^}]*overflow-y:\s*auto[^}]*word-break:\s*keep-all/s.test(uiCss)
    || (campusHtml.match(/x-anchor\.fixed\.offset\.8="\$refs\.trigger"/g) ?? []).length < 2
    || (campusHtml.match(/x-ref="trigger"/g) ?? []).length < 2
    || /\.appliance-info\.is-(?:above|below)/.test(uiCss)
    || !/<code x-show="applianceInfo\([^)]*\)\?\.code"/s.test(campusHtml)) {
    errors.push('Information buttons must be neutral 24px overlay disclosures with a separate technical code');
}
if (!/fn build_campus_window[\s\S]*?\.inner_size\(640\.0,\s*780\.0\)[\s\S]*?\.resizable\(false\)[\s\S]*?\.minimizable\(false\)[\s\S]*?\.maximizable\(false\)/s.test(trayRust)) {
    errors.push('The campus WebView must use the fixed 640x780 layout');
}
if (campusHtml.includes('durationFormat') || campusHtml.includes('duration-control')) {
    errors.push('Wash-tower time formatting must be automatic instead of user-configurable');
}
if (!/\.appliance-main\s*\{[^}]*display:\s*grid[^}]*height:\s*var\(--space-8\)[^}]*grid-template-columns:\s*96px\s+64px[^}]*justify-content:\s*space-between/s.test(uiCss)
    || !/\.appliance-main strong\s*\{[^}]*width:\s*96px[^}]*grid-column:\s*1[^}]*grid-row:\s*1[^}]*font-size:\s*16px/s.test(uiCss)
    || !/\.appliance-main small\s*\{[^}]*width:\s*64px[^}]*grid-column:\s*2[^}]*grid-row:\s*1[^}]*text-align:\s*right/s.test(uiCss)) {
    errors.push('Remaining time and finish time must share one fixed-width row');
}
const applianceTimeRules = uiCss.match(/\.appliance-main (?:strong|small)\s*\{[^}]*\}/g) ?? [];
if (applianceTimeRules.length !== 2 || applianceTimeRules.some((rule) => /text-overflow:\s*ellipsis|overflow:\s*hidden/.test(rule))) {
    errors.push('Wash-tower time values must not be truncated');
}
if (!/<p class="appliance-main">[^<]*<strong[\s\S]*<progress class="ui-progress appliance-progress"/s.test(campusHtml)
    || !/\.appliance-progress\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s.test(uiCss)
    || /\.appliance-progress\s*\{[^}]*position:\s*absolute/s.test(uiCss)) {
    errors.push('Appliance progress must appear below the time values instead of on the card edge');
}
if (!/\.ui-settings-group\s*\{[^}]*margin:\s*var\(--space-0\)[^}]*padding:\s*var\(--space-0\)[^}]*border:\s*var\(--space-0\)[^}]*background:\s*transparent/s.test(uiCss)
    || !/\.ui-settings-group legend\s*\{[^}]*padding:\s*var\(--space-0\)[^}]*font-size:\s*16px[^}]*letter-spacing:\s*0/s.test(uiCss)
    || !/\.ui-setting-row strong,[^{]*\{[^}]*font-size:\s*14px/s.test(uiCss)
    || !/\.ui-setting-row small,[^{]*\{[^}]*font-size:\s*12px/s.test(uiCss)) {
    errors.push('Settings groups must be unframed and use a 16px, 14px, and 12px hierarchy on the same left edge');
}
if (!/\.ui-shell-settings \.ui-tabs button,[\s\S]*?min-height:\s*var\(--space-8\)[^}]*padding:\s*var\(--space-2\)\s+var\(--space-2\)[^}]*font-size:\s*12px/s.test(uiCss)) {
    errors.push('Settings text buttons must use the compact 32px control size');
}
if (!/<fieldset class="laundry-filter-group">\s*<legend class="laundry-filter-label">구역<\/legend>/s.test(campusHtml)
    || !/<fieldset class="laundry-filter-group">\s*<legend class="laundry-filter-label">상태<\/legend>/s.test(campusHtml)
    || !/\.laundry-filters\s*\{[^}]*padding:\s*var\(--space-2\)[^}]*border:\s*var\(--border-width\) solid var\(--color-border\)/s.test(uiCss)
    || !/\.laundry-filter-group\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*gap:\s*var\(--space-1\)/s.test(uiCss)
    || !/\.laundry-filters \.ui-choice-group\s*\{[^}]*gap:\s*var\(--space-2\)/s.test(uiCss)) {
    errors.push('Laundry filters must use compact, semantic controls inside one divided block');
}
if (!/\.weekly-meals\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s.test(uiCss)) {
    errors.push('Pinned weekly menus must use a full-width single-column layout');
}
if (!campusHtml.includes('x-show="!currentWeeklyMenu()">이번 주 식단표가 아직 게시되지 않았습니다.')
    || !campusHtml.includes('x-for="post in currentWeeklyMenu() ? [currentWeeklyMenu()] : []"')
    || campusHtml.includes('meals?.data.pinnedMenus.length === 0')
    || !campusTs.includes("return this.meals?.data.currentWeeklyMenu?.post ?? null;")) {
    errors.push('The current weekly menu must use the server week verdict instead of the latest pinned post');
}
if (!/\.weekly-meal-image img\s*\{[^}]*height:\s*auto[^}]*object-fit:\s*contain/s.test(uiCss)) {
    errors.push('Pinned weekly menu images must preserve their full document aspect ratio');
}
if (!settingsHtml.includes('attendance-notification')
    || !settingsHtml.includes('notification-schedule')
    || !settingsHtml.includes('notification-actions')
    || settingsHtml.includes('notification-exceptions')
    || settingsHtml.includes('notification-permission')
    || settingsHtml.includes('attendance-settings')) {
    errors.push('Notification settings must combine attendance controls into one compact hierarchy');
}
if (!settingsHtml.includes('<details class="ui-settings-advanced">')
    || !settingsHtml.includes('<legend>개인정보</legend>')
    || !settingsHtml.includes('온보딩 다시 보기')) {
    errors.push('App settings must keep privacy visible and diagnostics inside the advanced disclosure');
}
if (!settingsHtml.includes('<footer class="ui-footer">') || !campusHtml.includes('<footer class="ui-footer">')) {
    errors.push('Project links must remain available through the shared footer');
}
if (!/fn build_settings_window[\s\S]*?\.inner_size\(448\.0,\s*680\.0\)[\s\S]*?\.resizable\(false\)/s.test(trayRust)) {
    errors.push('The settings WebView must use the fixed 448x680 layout');
}

if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log('UI system verification passed.');
}
