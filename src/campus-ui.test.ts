import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const campusHtml = readFileSync(new URL('./campus.html', import.meta.url), 'utf8');
const mealsPanelStart = campusHtml.indexOf('<section id="meals-panel"');
const mealsPanel = campusHtml.slice(mealsPanelStart, campusHtml.indexOf('</main>', mealsPanelStart));

test('생활 정보 종류는 메인 화면과 같은 밑줄형 탭으로 표시한다', () => {
    const navigationLabel = campusHtml.indexOf('aria-label="생활 정보 종류"');
    const navigationStart = campusHtml.lastIndexOf('<nav', navigationLabel);
    const navigationEnd = campusHtml.indexOf('</nav>', navigationStart);
    const navigation = campusHtml.slice(navigationStart, navigationEnd);

    assert.match(navigation, /role="tablist"/);
    assert.match(navigation, /\bflex\b/);
    assert.match(navigation, /\bborder-b\b/);
    assert.match(navigation, /role="tab"/);
    assert.match(navigation, /:aria-selected=/);
    assert.match(navigation, /after:bg-app-accent/);
    assert.doesNotMatch(navigation, /\bgrid-cols-2\b|\bbg-app-control\b|aria-current/);
});

test('워시타워 상세 카드는 실제 설치 구조대로 건조기를 세탁기 위에 표시한다', () => {
    assert.match(
        campusHtml,
        /x-for="entry in \[\{kind:'dryer', appliance:machine\.dryer}, \{kind:'washer', appliance:machine\.washer}]/,
    );
});

test('모든 식단 이미지는 비율을 유지하며 영역을 채운다', () => {
    const imageCount = mealsPanel.match(/<img\b/g)?.length ?? 0;
    const coverCount = mealsPanel.match(/\[&_img\]:object-cover/g)?.length ?? 0;

    assert.ok(imageCount > 0);
    assert.equal(coverCount, imageCount);
    assert.doesNotMatch(mealsPanel, /\[&_img\]:object-(?:fill|contain)/);
});

test('오늘의 식단 카드에는 게시 상태 뱃지를 표시하지 않는다', () => {
    assert.doesNotMatch(mealsPanel, /게시됨|게시 전/);
});

test('세탁 알림은 명시적인 추가 버튼과 모달 대화상자에서 세션을 선택한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.equal(laundryPanel.match(/세탁 알림 추가/g)?.length, 1);
    assert.match(laundryPanel, /<dialog[^>]*data-ui="laundry-alert-dialog"/);
    assert.match(laundryPanel, /aria-labelledby="laundry-alert-dialog-title"/);
    assert.match(laundryPanel, /id="laundry-alert-dialog-title"/);
    assert.match(laundryPanel, /@click="openLaundryAlertPicker\(\)"/);
    assert.match(laundryPanel, /x-for="option in laundryAlertOptions\(\)"/);
    assert.match(laundryPanel, /x-model="laundryAlertSelection"/);
    assert.match(laundryPanel, /@click="saveLaundryAlert\(\)"/);
    assert.match(laundryPanel, /laundryWatch \? '알림 변경' : '알림 추가'/);
    assert.match(campusHtml, /종료\s*전\s*알림/);
    assert.match(script, /set_laundry_watch/);
    assert.match(script, /laundryAlertOptions/);
    assert.match(
        script,
        /label:\s*`\$\{this\.machineName\(machine\.id\)\}\s+\$\{appliance === 'washer' \? '세탁기' : '건조기'\}\(\$\{this\.machineZoneLabel\(machine\.id\)\}\)\s*·\s*\$\{status\}`/,
    );
    assert.match(script, /saveLaundryAlert/);
    assert.match(script, /\.showModal\(\)/);
    assert.match(script, /\.close\(\)/);
    assert.match(script, /connectSettingsSnapshots/);
    assert.doesNotMatch(
        laundryPanel,
        /data-ui="laundry-alert-picker"|x-show="laundryAlertPickerOpen"|toggleLaundryWatch|홈에 표시 중|>\s*홈에 표시\s*</,
    );
    assert.doesNotMatch(mealsPanel, /새 식단 알림|setMealSubscription/);
    assert.doesNotMatch(script, /setMealSubscription|set_meal_subscription_enabled|mealSubscription/);
});
