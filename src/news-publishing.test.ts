import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const workflowPath = new URL('../.github/workflows/publish-news.yml', import.meta.url);

test('Discussion과 릴리즈를 news.json으로 만들어 GitHub Pages에 배포한다', () => {
    assert.equal(existsSync(workflowPath), true);
    const workflow = readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /discussion:/);
    assert.match(workflow, /release:/);
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /gh discussion list/);
    assert.match(workflow, /--label "소식"/);
    assert.match(workflow, /\.discussions\s+\| map/);
    assert.match(workflow, /news\.json/);
    assert.match(workflow, /actions\/upload-pages-artifact@/);
    assert.match(workflow, /actions\/deploy-pages@/);
});

test('질문과 논의는 Discussions로, 실행 가능한 작업은 Issues로 구분한다', () => {
    const config = readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8');
    const featureRequest = readFileSync(
        new URL('../.github/ISSUE_TEMPLATE/feature_request.yml', import.meta.url),
        'utf8',
    );
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const announcementForm = readFileSync(
        new URL('../.github/DISCUSSION_TEMPLATE/announcements.yml', import.meta.url),
        'utf8',
    );

    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/question.yml', import.meta.url)), false);
    assert.match(config, /\/discussions/);
    assert.match(config, /질문|논의/);
    assert.match(featureRequest, /구체적|실행 가능/);
    assert.match(readme, /GitHub Discussions/);
    assert.match(readme, /GitHub Issues/);
    assert.match(announcementForm, /labels: \["소식"]/);
    assert.match(announcementForm, /앱의 \*\*소식\*\* 탭/);
});
