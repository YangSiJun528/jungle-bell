import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const readRepositoryFile = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

test('버그·기능 요청·질문은 모두 GitHub Issues 양식으로 접수한다', () => {
    const templates = [
        '.github/ISSUE_TEMPLATE/bug.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/ISSUE_TEMPLATE/question.yml',
    ];

    for (const template of templates) {
        assert.equal(existsSync(new URL(template, repositoryRoot)), true, `${template}이 없습니다.`);
    }

    const config = readRepositoryFile('.github/ISSUE_TEMPLATE/config.yml');
    const footer = readRepositoryFile('frontend/src/app/shell/DashboardFooter.tsx');
    const readme = readRepositoryFile('README.md');

    assert.match(config, /blank_issues_enabled:\s*false/);
    assert.doesNotMatch(config, /discussions?/i);
    assert.match(footer, /\/issues\/new\/choose/);
    assert.doesNotMatch(footer, /\/discussions(?:\/|\b)/);
    assert.match(readme, /\?template=bug\.yml/);
    assert.match(readme, /\?template=feature_request\.yml/);
    assert.match(readme, /\?template=question\.yml/);
    assert.doesNotMatch(readme, /GitHub Discussions|\/discussions(?:\/|\b)/i);
});
