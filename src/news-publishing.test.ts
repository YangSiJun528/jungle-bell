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
    assert.doesNotMatch(workflow, /^\s{2}release:/m);
    assert.doesNotMatch(workflow, /repos\/\$GITHUB_REPOSITORY\/releases/);
    assert.doesNotMatch(workflow, /release-items/);
    assert.match(workflow, /news\.json/);
    assert.match(workflow, /actions\/upload-pages-artifact@/);
    assert.match(workflow, /actions\/deploy-pages@/);
});

test('버그만 Issues로 받고 질문·기능 요청·설문·공지는 Discussions로 구분한다', () => {
    const config = readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const announcementForm = readFileSync(
        new URL('../.github/DISCUSSION_TEMPLATE/announcements.yml', import.meta.url),
        'utf8',
    );
    const questionForm = readFileSync(
        new URL('../.github/DISCUSSION_TEMPLATE/q-a.yml', import.meta.url),
        'utf8',
    );
    const ideaForm = readFileSync(
        new URL('../.github/DISCUSSION_TEMPLATE/ideas.yml', import.meta.url),
        'utf8',
    );

    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/question.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/feature_request.yml', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url)), true);
    assert.match(config, /\/discussions/);
    assert.match(config, /궁금해요/);
    assert.match(config, /기능 (추가 )?요청/);
    assert.match(config, /설문/);
    assert.match(config, /공지/);
    assert.match(readme, /GitHub Discussions.+궁금해요.+기능 추가 요청.+설문.+공지/);
    assert.match(readme, /GitHub Issues.+버그/);
    assert.match(announcementForm, /labels: \["소식"]/);
    assert.match(announcementForm, /앱의 \*\*소식\*\* 탭/);
    assert.doesNotMatch(questionForm, /labels: \["소식"]/);
    assert.doesNotMatch(ideaForm, /labels: \["소식"]/);
});
