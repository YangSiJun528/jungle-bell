import {existsSync, readFileSync} from 'node:fs';

const approvedSpacing = new Set([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
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

const errors = [];
const lines = uiCss.split('\n');
const spacingProperty = /^\s*(margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|inset|top|right|bottom|left)\s*:/;

for (const [index, line] of lines.entries()) {
    if (!spacingProperty.test(line)) continue;
    for (const match of line.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        const value = Number(match[1]);
        if (!approvedSpacing.has(value)) errors.push(`src/ui.css:${index + 1} uses off-scale spacing ${match[0]} in: ${line.trim()}`);
    }
}

const expectedTokens = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];
for (const value of expectedTokens) {
    if (!uiCss.includes(`: ${value}px;`)) errors.push(`Spacing token ${value}px is missing from src/ui.css`);
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

if (!/\.laundry-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s.test(uiCss)) {
    errors.push('The default wash-tower grid must show three columns');
}
if (!/<ul class="availability-key"[^>]*>[\s\S]*?data-zone="men"[\s\S]*?data-zone="common"[\s\S]*?data-zone="women"[\s\S]*?data-state="unavailable"/s.test(campusHtml)
    || !/<table class="availability-layout">[\s\S]*?<caption class="sr-only">[\s\S]*?row in \[\{kind:'dryer', label:'건조기'\}, \{kind:'washer', label:'세탁기'\}\]/s.test(campusHtml)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="men"\] \.availability-tower-state[^}]*background:\s*var\(--color-men\)/s.test(uiCss)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="common"\] \.availability-tower-state[^}]*background:\s*var\(--color-common\)/s.test(uiCss)
    || !/\.availability-layout td\[data-state="available"\]\[data-zone="women"\] \.availability-tower-state[^}]*background:\s*var\(--color-women\)/s.test(uiCss)
    || !/\.availability-tower-state\s*\{[^}]*background:\s*var\(--color-text-faint\)/s.test(uiCss)
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
if (!/\.laundry-card\s*\{[^}]*height:\s*248px[^}]*grid-template-rows:\s*var\(--space-12\)\s+minmax\(0,\s*1fr\)/s.test(uiCss)
    || campusHtml.includes('appliance-error') || uiCss.includes('.appliance-error')
    || !/<div class="appliance-status">[\s\S]*?<span class="status-badge"[\s\S]*?<details class="ui-info appliance-info"/s.test(campusHtml)) {
    errors.push('Wash-tower cards must keep fixed geometry and place explanations beside the status badge');
}
if (!/\.ui-info summary\s*\{[^}]*width:\s*var\(--space-6\)[^}]*height:\s*var\(--space-6\)/s.test(uiCss)
    || !/\.ui-info-popover\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*40[^}]*max-height:\s*calc\(100vh - var\(--space-6\)\)[^}]*overflow-y:\s*auto/s.test(uiCss)
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
if (!/\.appliance-main\s*\{[^}]*display:\s*flex[^}]*height:\s*44px[^}]*flex-direction:\s*column/s.test(uiCss)) {
    errors.push('Remaining time and finish time must use two fixed-height rows');
}
const applianceTimeRules = uiCss.match(/\.appliance-main (?:strong|small)\s*\{[^}]*\}/g) ?? [];
if (applianceTimeRules.length !== 2 || applianceTimeRules.some((rule) => /text-overflow:\s*ellipsis|overflow:\s*hidden/.test(rule))) {
    errors.push('Wash-tower time values must not be truncated');
}
if (!/<p class="appliance-main">[^<]*<strong[\s\S]*<progress class="ui-progress appliance-progress"/s.test(campusHtml)
    || /\.appliance-progress\s*\{[^}]*position:\s*absolute/s.test(uiCss)) {
    errors.push('Appliance progress must appear below the time values instead of on the card edge');
}
if (!/\.ui-settings-group\s*\{[^}]*margin:\s*var\(--space-0\)[^}]*padding:\s*var\(--space-0\)[^}]*border:\s*var\(--space-0\)[^}]*background:\s*transparent/s.test(uiCss)
    || !/\.ui-settings-group legend\s*\{[^}]*padding:\s*var\(--space-0\)[^}]*font-size:\s*16px[^}]*letter-spacing:\s*0/s.test(uiCss)
    || !/\.ui-setting-row strong,[^{]*\{[^}]*font-size:\s*14px/s.test(uiCss)
    || !/\.ui-setting-row small,[^{]*\{[^}]*font-size:\s*12px/s.test(uiCss)) {
    errors.push('Settings groups must be unframed and use a 16px, 14px, and 12px hierarchy on the same left edge');
}
if (!/\.ui-shell-settings \.ui-tabs button,[\s\S]*?min-height:\s*var\(--space-8\)[^}]*padding:\s*var\(--space-2\)\s+var\(--space-3\)[^}]*font-size:\s*12px/s.test(uiCss)) {
    errors.push('Settings text buttons must use the compact 32px control size');
}
if (!/<fieldset class="laundry-filter-group">\s*<legend class="laundry-filter-label">구역<\/legend>/s.test(campusHtml)
    || !/<fieldset class="laundry-filter-group">\s*<legend class="laundry-filter-label">상태<\/legend>/s.test(campusHtml)
    || !/\.laundry-filters\s*\{[^}]*padding:\s*var\(--space-3\)[^}]*border:\s*1px solid var\(--color-border\)/s.test(uiCss)
    || !/\.laundry-filter-group\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*gap:\s*var\(--space-1\)/s.test(uiCss)
    || !/\.laundry-filters \.ui-choice-group\s*\{[^}]*gap:\s*var\(--space-2\)/s.test(uiCss)) {
    errors.push('Laundry filters must use compact, semantic controls inside one divided block');
}
if (!/\.weekly-meals\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s.test(uiCss)) {
    errors.push('Pinned weekly menus must use a full-width single-column layout');
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
