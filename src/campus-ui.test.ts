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

test('모든 식단 이미지는 영역을 늘려 채운다', () => {
    const imageCount = mealsPanel.match(/<img\b/g)?.length ?? 0;
    const fillCount = mealsPanel.match(/\[&_img\]:object-fill/g)?.length ?? 0;

    assert.ok(imageCount > 0);
    assert.equal(fillCount, imageCount);
    assert.doesNotMatch(mealsPanel, /\[&_img\]:object-(?:cover|contain)/);
});

test('오늘의 식단 카드에는 게시 상태 뱃지를 표시하지 않는다', () => {
    assert.doesNotMatch(mealsPanel, /게시됨|게시 전/);
});

test('세탁 세션과 급식은 홈 대시보드 구독을 화면에서 설정한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');

    assert.match(campusHtml, /홈에 표시/);
    assert.match(campusHtml, /종료\s*전\s*알림/);
    assert.match(campusHtml, /새 식단 알림/);
    assert.match(script, /set_laundry_watch/);
    assert.match(script, /set_meal_subscription_enabled/);
    assert.match(script, /connectSettingsSnapshots/);
});
