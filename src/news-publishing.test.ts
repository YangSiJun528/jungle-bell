import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const workflowPath = new URL('../.github/workflows/publish-news.yml', import.meta.url);

test('소식 라벨이 붙은 Discussion만 news.json으로 만들어 GitHub Pages에 배포한다', () => {
    assert.equal(existsSync(workflowPath), true);
    const workflow = readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /discussion:/);
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /gh discussion list/);
    assert.match(workflow, /--label "소식"/);
    assert.match(workflow, /\.discussions\s+\| map/);
    assert.match(workflow, /select\(\.category\.name == "공지"\)/);
    assert.doesNotMatch(workflow, /^\s{2}release:/m);
    assert.doesNotMatch(workflow, /repos\/\$GITHUB_REPOSITORY\/releases/);
    assert.doesNotMatch(workflow, /release-items/);
    assert.match(workflow, /news\.json/);
    assert.match(workflow, /actions\/upload-pages-artifact@/);
    assert.match(workflow, /actions\/deploy-pages@/);
});

test('상단 고정 라벨 공지를 먼저, 각 그룹에서는 작성일 최신순으로 배치한다', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /--json number,title,body,category,labels,createdAt,updatedAt,url/);
    assert.match(workflow, /pinned: \(\[\.labels\[\]\?\.name\] \| any\(\. == "상단 고정"\)\)/);
    assert.match(workflow, /map\(select\(\.pinned\)\)\s*\| sort_by\(\.createdAt\)\s*\| reverse/);
    assert.match(workflow, /map\(select\(\.pinned \| not\)\)\s*\| sort_by\(\.createdAt\)\s*\| reverse/);
});

test('버그만 Issues로 받고 공지·건의·질문은 Discussions로 구분한다', () => {
    const config = readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const settings = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const settingsScript = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
    const campus = readFileSync(new URL('./campus.html', import.meta.url), 'utf8');

    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/question.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/feature_request.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url)), true);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/announcements.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/ideas.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/q-a.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/공지.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/궁금해요.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/DISCUSSION_TEMPLATE/건의하기.yml', import.meta.url)), false);
    assert.match(config, /\/discussions\/new\?category=%EA%B6%81%EA%B8%88%ED%95%B4%EC%9A%94/);
    assert.match(config, /\/discussions\/new\?category=%EA%B1%B4%EC%9D%98%ED%95%98%EA%B8%B0/);
    assert.match(config, /궁금해요/);
    assert.match(config, /건의하기/);
    assert.match(config, /name: "Slack으로 문의하기"/);
    assert.match(config, /https:\/\/krafton-aliens\.slack\.com\/team\/U0AHGCT20DQ/);
    assert.match(config, /name: "이메일로 문의하기"/);
    assert.match(config, /https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=yangsijun5528%40gmail\.com/);
    assert.ok(config.indexOf('name: "건의하기"') < config.indexOf('name: "Slack으로 문의하기"'));
    assert.ok(config.indexOf('name: "Slack으로 문의하기"') < config.indexOf('name: "이메일로 문의하기"'));
    assert.match(readme, /GitHub Discussions.+공지.+건의하기.+궁금해요/);
    assert.match(readme, /GitHub Issues.+버그/);
    assert.doesNotMatch(readme, /krafton-aliens\.slack\.com|mailto:/);

    assert.doesNotMatch(settings, /support-links-title|aria-label="공개 문의"|aria-label="비공개 문의"/);
    assert.doesNotMatch(settings, /피드백 보내기|궁금해요|건의하기|버그 제보|>Slack<|>이메일</);
    assert.doesNotMatch(settings, /\/issues\/new|\/discussions\/new|krafton-aliens\.slack\.com|mailto:/);
    assert.doesNotMatch(settings, /앱 종료|quitApp/);
    assert.doesNotMatch(settingsScript, /quitApp|run_tray_panel_action/);
    assert.doesNotMatch(settings, /app-info-title|<h2[^>]*>앱 정보<\/h2>/);
    assert.match(settings, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell"/);
    assert.match(settings, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell\/releases"/);
    assert.doesNotMatch(settings, /<footer class="mt-auto/);
    assert.doesNotMatch(campus, /<footer class="mt-auto/);
    assert.doesNotMatch(
        settings,
        /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell\/discussions"/,
    );
    assert.doesNotMatch(
        campus,
        /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell\/discussions"/,
    );
});
