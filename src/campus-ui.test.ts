import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const campusHtml = readFileSync(new URL('./campus.html', import.meta.url), 'utf8');
const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const mealsPanelStart = campusHtml.indexOf('<section id="meals-panel"');
const mealsPanel = campusHtml.slice(mealsPanelStart, campusHtml.indexOf('</main>', mealsPanelStart));
const todayMealsPanelStart = mealsPanel.indexOf('<section aria-labelledby="today-meals-title"');
const todayMealsPanel = mealsPanel.slice(
    todayMealsPanelStart,
    mealsPanel.indexOf('<section aria-labelledby="weekly-meals-title"', todayMealsPanelStart),
);

test('생활 정보 종류는 메인 화면과 같은 밑줄형 탭으로 표시한다', () => {
    const navigationLabel = campusHtml.indexOf('aria-label="생활 정보 종류"');
    const navigationStart = campusHtml.lastIndexOf('<nav', navigationLabel);
    const navigationEnd = campusHtml.indexOf('</nav>', navigationStart);
    const navigation = campusHtml.slice(navigationStart, navigationEnd);

    assert.match(navigation, /role="tablist"/);
    assert.match(navigation, /\bui-tabs\b/);
    assert.equal(navigation.match(/class="ui-tab"/g)?.length, 2);
    assert.equal(navigation.match(/role="tab"/g)?.length, 2);
    assert.match(navigation, /:aria-selected=/);
    assert.match(navigation, /:tabindex=/);
    assert.equal(navigation.match(/@keydown\.arrow-left\.prevent=/g)?.length, 2);
    assert.equal(navigation.match(/@keydown\.arrow-right\.prevent=/g)?.length, 2);
    assert.equal(navigation.match(/\$nextTick\(\(\) => \$refs\.(?:laundryTab|mealsTab)\.focus\(\)\)/g)?.length, 4);
    assert.doesNotMatch(navigation, /\bgrid-cols-2\b|\bbg-app-control\b|aria-current/);
});

test('워시타워 상세 카드는 실제 설치 구조대로 건조기를 세탁기 위에 표시한다', () => {
    assert.match(
        campusHtml,
        /x-for="entry in \[\{kind:'dryer', appliance:machine\.dryer}, \{kind:'washer', appliance:machine\.washer}]/,
    );
});

test('워시타워 카드는 알림 버튼 유무와 관계없이 기기 행과 카드 하단을 맞춘다', () => {
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.match(laundryPanel, /class="grid grid-cols-3 items-stretch gap-4"/);
    assert.match(laundryPanel, /grid-rows-\[32px_112px_112px\]/);
    assert.match(laundryPanel, /<section class="h-28 min-w-0 p-2/);
    assert.match(laundryPanel, /data-skeleton="laundry"[\s\S]*<section class="h-28 /);
    assert.doesNotMatch(laundryPanel, /items-start|minmax\(88px,auto\)|min-h-\[88px\]/);
});

test('모든 식단 이미지는 비율을 유지하며 영역을 채운다', () => {
    const imageCount = mealsPanel.match(/<img\b/g)?.length ?? 0;
    const coverCount = mealsPanel.match(/\[&_img\]:object-cover/g)?.length ?? 0;

    assert.ok(imageCount > 0);
    assert.equal(coverCount, imageCount);
    assert.doesNotMatch(mealsPanel, /\[&_img\]:object-(?:fill|contain)/);
});

test('오늘의 식단 이미지는 같은 높이의 영역에서 중앙 기준으로 비율을 유지하며 잘린다', () => {
    assert.match(todayMealsPanel, /<article class="[^"]*\bflex\b[^"]*\bflex-col\b/);
    assert.match(todayMealsPanel, /<p class="[^"]*\bflex-1\b[^"]*" x-show="!todayMeal\(period\)"/);
    assert.match(todayMealsPanel, /<div class="[^"]*\bflex-1\b[^"]*" x-show="todayMeal\(period\)"/);
    assert.match(
        uiStyles,
        /section\[aria-labelledby="today-meals-title"] \.cursor-zoom-in\s*{[^}]*position:\s*relative;/s,
    );
    assert.match(
        uiStyles,
        /section\[aria-labelledby="today-meals-title"] \.cursor-zoom-in > img\s*{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/s,
    );
});

test('오늘의 식단 카드에는 게시 상태 뱃지를 표시하지 않는다', () => {
    assert.doesNotMatch(mealsPanel, /게시됨|게시 전/);
});

test('세탁 알림은 작동 중인 기기 안에서 시작하고 같은 자리에서 조정한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.match(laundryPanel, /data-ui="laundry-inline-watch"/);
    assert.match(
        laundryPanel,
        /isWatchedLaundry\(machine\.id,\s*entry\.kind,\s*entry\.appliance\?\.sessionId\)/,
    );
    assert.match(laundryPanel, /canWatchLaundry\(entry\.appliance\)/);
    assert.match(laundryPanel, /'알림 설정'\s*:\s*'알림 받기'/);
    assert.match(laundryPanel, /이 작업이 끝나면 알림 받기/);
    assert.match(laundryPanel, /알림을 받을 예정이에요/);
    assert.match(laundryPanel, /추적 종료/);
    assert.match(laundryPanel, /종료 전 알림/);
    assert.match(
        laundryPanel,
        /watchLaundry\(machine\.id,\s*entry\.kind,\s*entry\.appliance\?\.sessionId\)/,
    );
    assert.match(
        laundryPanel,
        /updateLaundryNotice\(Number\(\$event\.currentTarget\.value\), \$event\.currentTarget\)/,
    );
    assert.match(laundryPanel, /clearLaundryWatch\(\)/);
    assert.match(script, /set_laundry_watch/);
    assert.match(script, /isWatchedLaundry/);
    assert.match(script, /canWatchLaundry/);
    assert.match(script, /watchLaundry/);
    assert.match(script, /const watchedMachine = this\.laundryWatch\?\.machineId === machine\.id/);
    assert.match(script, /if \(!watchedMachine && !laundryZoneMatchesAccess/);
    assert.match(script, /connectSettingsSnapshots/);
    assert.doesNotMatch(
        laundryPanel,
        /<dialog|data-ui="laundry-alert-dialog"|openLaundryAlertPicker|laundryAlertSelection|세탁 알림 추가|알림받는 중/,
    );
    assert.doesNotMatch(script, /laundryAlertOptions|openLaundryAlertPicker|closeLaundryAlertPicker|saveLaundryAlert|watchedLaundryLabel/);
    assert.doesNotMatch(mealsPanel, /새 식단 알림|setMealSubscription/);
    assert.doesNotMatch(script, /setMealSubscription|set_meal_subscription_enabled|mealSubscription/);
});

test('매초 바뀌는 세탁 현황은 live region으로 반복 낭독하지 않는다', () => {
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.doesNotMatch(laundryPanel, /class="grid grid-cols-2 gap-2"\s+aria-live=/);
    assert.doesNotMatch(laundryPanel, /class="grid grid-cols-3 items-stretch gap-4"\s+aria-live=/);
});

test('세탁 알림 설정은 저장 성공 뒤에만 닫고 실패한 시간 선택을 원래 값으로 복원한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.match(laundryPanel, /watchLaundry\([^)]*\)\.then\(\(saved\)/);
    assert.match(laundryPanel, /clearLaundryWatch\(\)\.then\(\(saved\)/);
    assert.doesNotMatch(
        laundryPanel,
        /watchLaundry\(machine\.id,\s*entry\.kind,\s*entry\.appliance\?\.sessionId\);\s*watchMenuOpen = false/,
    );
    assert.match(script, /const previousNotifyBeforeMins = this\.laundryWatch\.notifyBeforeMins/);
    assert.match(script, /selectElement\.value = String\(previousNotifyBeforeMins\)/);
    assert.match(script, /return saved/);
});

test('상단 표 아래에 필터와 독립적인 남성·여성 세탁 현황 카드를 표시한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );
    const overviewTable = laundryPanel.indexOf('<table');
    const situationCards = laundryPanel.indexOf('data-ui="laundry-access-situations"');
    const filters = laundryPanel.indexOf('name="laundry-access"');
    const situationMethodStart = script.indexOf('laundryAccessSituations(');
    const situationMethodEnd = script.indexOf('laundrySituationAccessLabel(', situationMethodStart);
    const situationMethod = script.slice(situationMethodStart, situationMethodEnd);

    assert.ok(overviewTable >= 0);
    assert.ok(situationCards > overviewTable);
    assert.ok(filters > situationCards);
    assert.match(laundryPanel, /지금 세탁해도 될까요\?/);
    assert.match(laundryPanel, /x-for="situation in laundryAccessSituations\(\)"/);
    assert.match(laundryPanel, /laundrySituationRecommendationLabel\(situation\)/);
    assert.doesNotMatch(laundryPanel, /1–7번 워시타워|6–9번 워시타워|공용 6·7번/);
    assert.doesNotMatch(
        laundryPanel,
        /situation\.(?:startableLoads|washerUsable|dryerUsable|activeWashers|activeDryers|total)/,
    );
    assert.doesNotMatch(laundryPanel, /건조 여유|완료 표시는|동시에 가동 중이면/);
    assert.match(script, /assessLaundryAccessSituation\(machines, 'men', reliable, this\.clockNow\)/);
    assert.match(script, /assessLaundryAccessSituation\(machines, 'women', reliable, this\.clockNow\)/);
    assert.match(script, /comfortable: '여유 있음'/);
    assert.match(script, /return '건조 대기 가능성 낮음'/);
    assert.doesNotMatch(
        script,
        /현재 기준|situation\.startableLoads|기다리는 게 좋아요|괜찮을 것 같아요|널널함|자리 부족/,
    );
    assert.doesNotMatch(situationMethod, /this\.laundryAccess|this\.laundryFilter/);
});

test('빈자리 알림 기능은 제거하고 기존 기기 종료 알림만 유지한다', () => {
    const script = readFileSync(new URL('./campus.ts', import.meta.url), 'utf8');
    const laundryPanel = campusHtml.slice(
        campusHtml.indexOf('<section id="laundry-panel"'),
        campusHtml.indexOf('<section id="meals-panel"'),
    );

    assert.match(laundryPanel, /종료 전 알림/);
    assert.match(script, /set_laundry_watch/);
    assert.doesNotMatch(laundryPanel, /laundryVacancy|laundry-vacancy|빈자리 알림/);
    assert.doesNotMatch(script, /laundryVacancy|laundry-vacancy|set_laundry_vacancy_watch|laundryAlertMode/);
});
