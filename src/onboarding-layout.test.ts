import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const onboarding = readFileSync(new URL('./onboarding.html', import.meta.url), 'utf8');
const onboardingScript = readFileSync(new URL('./onboarding.ts', import.meta.url), 'utf8');
const tray = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');

test('온보딩은 핵심 설정 네 단계와 하나의 진행 막대로 끝낸다', () => {
    assert.match(onboardingScript, /const TOTAL_STEPS = 4;/);
    assert.equal(onboarding.match(/data-step-panel="/g)?.length, 4);
    assert.equal(onboarding.match(/<progress\b/g)?.length, 1);
    assert.match(onboarding, /<progress[^>]*class="[^"]*\bui-progress\b/);
    assert.doesNotMatch(onboarding, /aria-label="진행 단계"/);
    assert.match(onboarding, /<fieldset[^>]*x-show="step === 0"[^>]*>\s*<legend[^>]*>운영체제 선택/);
});

test('단계를 바꾸면 새 단계 제목으로 키보드 포커스를 옮긴다', () => {
    assert.match(onboardingScript, /requestAnimationFrame\(\(\) =>/);
    assert.match(
        onboardingScript,
        /querySelector<HTMLElement>\(`\[data-step-panel="\$\{nextStep\}"\] h2`\)\s*\?\.focus\(\)/,
    );
    assert.equal(onboarding.match(/<h2[^>]*tabindex="-1"/g)?.length, 4);
});

test('트레이 안내 문장은 한글 음절 중간에서 줄바꿈하지 않는다', () => {
    assert.match(
        onboarding,
        /<p class="ui-page-subtitle max-w-prose \[word-break:keep-all\]">[\s\S]*?생활 정보를 열 수 있습니다\.<\/p>/,
    );
});

test('시작과 종료 출석 알림 설정을 위아래의 내용 높이 카드로 배치한다', () => {
    const schedulesStart = onboarding.indexOf('<div class="grid min-h-0 flex-1', onboarding.indexOf('onboarding-notification-title'));
    const schedulesOpeningTagEnd = onboarding.indexOf('>', schedulesStart);
    const schedulesOpeningTag = onboarding.slice(schedulesStart, schedulesOpeningTagEnd);

    assert.ok(schedulesStart >= 0);
    assert.match(schedulesOpeningTag, /\bcontent-start\b/);
    assert.doesNotMatch(schedulesOpeningTag, /\bgrid-rows-2\b/);
    assert.doesNotMatch(schedulesOpeningTag, /\bgrid-cols-2\b/);
});

test('560x720 Tauri 창에서 알림 일정 카드의 컨트롤이 테두리 안에 들어오도록 압축한다', () => {
    const schedulesMarker = onboarding.indexOf('data-ui="notification-schedules"');
    const schedulesStart = onboarding.lastIndexOf('<div', schedulesMarker);
    const schedulesEnd = onboarding.indexOf('</section>', schedulesStart);
    const schedules = onboarding.slice(schedulesStart, schedulesEnd);

    assert.match(tray, /const UTILITY_WINDOW_WIDTH: f64 = 560\.0;/);
    assert.match(tray, /const STANDARD_WINDOW_HEIGHT: f64 = 720\.0;/);
    assert.ok(schedulesMarker >= 0);
    assert.ok(schedulesStart >= 0);
    assert.match(schedules, /\bgap-3\b/);
    assert.equal(schedules.match(/<label class="ui-settings-row\b/g)?.length, 2);
    assert.equal(schedules.match(/<span class="ui-toggle">/g)?.length, 2);
    assert.equal(schedules.match(/<button[^>]*class="[^"]*\bui-control\b[^"]*"[^>]*role="combobox"/g)?.length, 2);
    assert.doesNotMatch(schedules, /간격|startInterval|endInterval|saveInterval/);
});

test('최소 높이에서도 단계 내용은 스크롤되고 하단 이동 버튼은 고정된다', () => {
    const stepScroll = onboarding.match(
        /<article[^>]*data-ui="onboarding-step-scroll"[^>]*class="([^"]+)"/,
    )?.[1] ?? '';

    assert.match(stepScroll, /\bui-scroll-region\b/);
    assert.match(stepScroll, /\bui-scroll-region--inset\b/);
    assert.match(stepScroll, /\bpy-3\b/);
    assert.doesNotMatch(stepScroll, /\bp-3\b|\bpx-/);
    assert.match(onboarding, /<footer[^>]*class="[^"]*\bflex-none\b/);
    assert.doesNotMatch(onboarding, /<article[^>]*class="[^"]*\boverflow-hidden\b/);
});

test('마지막 단계는 명시적인 시작하기 동작으로 완료를 저장하고 창을 닫는다', () => {
    const footerStart = onboarding.indexOf('<footer');
    const footerEnd = onboarding.indexOf('</footer>', footerStart);
    const footer = onboarding.slice(footerStart, footerEnd);

    assert.match(footer, /:disabled="isLast \? finalActionDisabled : nextDisabled"/);
    assert.match(footer, /:aria-busy="isLast && completionPending"/);
    assert.match(onboardingScript, /get finalActionDisabled\(\) \{ return this\.completionPending; \}/);
    assert.match(onboardingScript, /if \(this\.completionPending\) return '시작하는 중'/);
    assert.match(onboardingScript, /await this\.complete\(\)/);
    assert.match(onboardingScript, /await invoke\('complete_onboarding'\)/);
    assert.match(onboardingScript, /await getCurrentWindow\(\)\.close\(\)/);
    assert.doesNotMatch(onboardingScript, /scheduleComplete|completionScheduled/);
    assert.match(onboarding, /설정을 확인한 뒤 시작하기를 눌러 완료해 주세요\./);
    assert.match(onboarding, /완료 저장 실패/);
    assert.match(onboarding, /창 닫기 실패/);
});

test('온보딩 알림 스위치는 시작과 종료 맥락을 이름에 포함한다', () => {
    assert.match(onboarding, /aria-label="시작 출석 알림 사용"/);
    assert.match(onboarding, /aria-label="종료 출석 알림 사용"/);
});
