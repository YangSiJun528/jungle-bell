import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertDraft, assertVersionIncrease, compareVersions, parseVersion, verifyRelease} from './verify-release-policy.mjs';

const release = (tag, overrides = {}) => ({
    id: 42, tag_name: tag, draft: false, prerelease: tag.includes('-'),
    published_at: '2026-09-16T12:00:00Z', ...overrides,
});
const draft = (tag, overrides = {}) => release(tag, {draft: true, published_at: null, ...overrides});

test('versions follow numeric SemVer precedence, including beta.10 and release candidates', () => {
    const versions = ['v0.6.2-alpha.9', 'v0.6.2-beta.2', 'v0.6.2-beta.10', 'v0.6.2-rc.0', 'v0.6.2', 'v0.6.10', 'v0.10.0', 'v1.0.0'];
    for (let index = 1; index < versions.length; index += 1) {
        assert.equal(compareVersions(parseVersion(versions[index - 1]), parseVersion(versions[index])), -1);
    }
});

test('stable releases must increase, independently of a future beta release', () => {
    const history = [release('v0.6.1'), release('v0.7.0-beta.1')];
    assert.throws(() => assertVersionIncrease('v0.6.0', history), /must be newer/);
    assert.throws(() => assertVersionIncrease('v0.6.1', history), /must be newer/);
    assert.doesNotThrow(() => assertVersionIncrease('v0.6.2', history));
});

test('prereleases must exceed stable versions and earlier prereleases in the same version series', () => {
    const history = [release('v0.6.1'), release('v0.6.2-beta.9'), release('v0.7.0-beta.1')];
    for (const tag of ['v0.6.1-rc.1', 'v0.6.2-beta.8', 'v0.6.2-beta.9', 'v0.6.2-alpha.99']) {
        assert.throws(() => assertVersionIncrease(tag, history), /must be newer/);
    }
    for (const tag of ['v0.6.2-beta.10', 'v0.6.2-rc.0', 'v0.6.3-beta.0']) {
        assert.doesNotThrow(() => assertVersionIncrease(tag, history));
    }
});

test('stable promotion and the first release are allowed; drafts do not reserve versions', () => {
    assert.doesNotThrow(() => assertVersionIncrease('v0.6.2', [release('v0.6.2-rc.1')]));
    assert.doesNotThrow(() => assertVersionIncrease('v0.1.0', []));
    assert.doesNotThrow(() => assertVersionIncrease('v0.6.2', [draft('v0.6.2'), draft('v9.0.0')]));
});

test('legacy missing v prefix and incorrect historical prerelease flags are supported', () => {
    const history = [release('0.0.1-beta.1', {prerelease: false}), release('v0.0.3-beta.11', {prerelease: false})];
    assert.doesNotThrow(() => assertVersionIncrease('v0.0.3', history));
    assert.throws(() => assertVersionIncrease('v0.0.3-beta.10', history), /must be newer/);
});

test('draft retries are permitted but published, re-drafted and replaced releases are rejected', () => {
    assert.doesNotThrow(() => assertDraft('v0.6.2', draft('v0.6.2'), '42'));
    assert.throws(() => assertDraft('v0.6.2', release('v0.6.2'), '42'), /already published/);
    assert.throws(() => assertDraft('v0.6.2', release('v0.6.2', {draft: true}), '42'), /already published/);
    assert.throws(() => assertDraft('v0.6.2', draft('v0.6.2', {id: 43}), '42'), /identity changed/);
    assert.throws(() => assertDraft('v0.6.2', draft('v0.6.3'), '42'), /identity changed/);
    assert.throws(() => assertDraft('v0.6.2-beta.1', draft('v0.6.2-beta.1', {prerelease: false})), /prerelease setting/);
});

test('missing metadata and unrecognized tags fail closed', () => {
    assert.throws(() => assertDraft('v0.6.2', draft('v0.6.2', {published_at: undefined})), /already published/);
    assert.throws(() => assertDraft('0.6.2', draft('0.6.2')), /start with v/);
    for (const tag of ['v0.6.02', 'v0.6.2-beta.01', 'v0.6.2-preview.1', '--help']) {
        assert.throws(() => parseVersion(tag), /Unsupported/);
    }
    assert.throws(() => assertVersionIncrease('v0.6.2', [release('unrecognized')]), /Unsupported/);
});

test('every history page is considered and history is refreshed after approval', () => {
    const calls = [];
    let history = [[release('v0.6.1')], [release('v0.5.9')]];
    const run = (command, args) => {
        calls.push([command, args]);
        return JSON.stringify(args.includes('--paginate') ? history : draft('v0.6.2'));
    };
    const options = {tag: 'v0.6.2', repository: 'owner/repo', releaseId: '42', run};
    verifyRelease(options);
    history = [[release('v0.6.1')], [release('v0.6.3')]];
    assert.throws(() => verifyRelease(options), /v0.6.3/);
    assert.ok(calls.every(([command]) => command === 'gh'));
    assert.ok(calls.some(([, args]) => args.includes('--paginate') && args.includes('--slurp')));
});

test('an individual upload rerun rechecks publication and does not need the prepare job', () => {
    let target = draft('v0.6.2');
    const options = {
        tag: 'v0.6.2', repository: 'owner/repo', releaseId: '42', draftOnly: true,
        run: (_command, args) => {
            assert.deepEqual(args, ['api', 'repos/owner/repo/releases/42']);
            return JSON.stringify(target);
        },
    };
    verifyRelease(options);
    target = release('v0.6.2');
    assert.throws(() => verifyRelease(options), /already published/);
});

test('GitHub errors and malformed history stop release verification', () => {
    const options = {tag: 'v0.6.2', repository: 'owner/repo', releaseId: '42'};
    assert.throws(() => verifyRelease({...options, run: () => {throw new Error('API unavailable');}}), /API unavailable/);
    assert.throws(() => verifyRelease({...options, run: (_command, args) => JSON.stringify(
        args.includes('--paginate') ? {} : draft('v0.6.2'),
    )}), /Invalid paginated/);
});
