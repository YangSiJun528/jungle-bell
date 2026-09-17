#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const tagPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/u;

export function parseVersion(tag) {
    const match = typeof tag === 'string' && tag.match(tagPattern);
    if (!match) throw new Error(`Unsupported release tag: ${String(tag)}`);
    return {
        core: match.slice(1, 4).map(BigInt),
        stage: match[4] ?? null,
        sequence: BigInt(match[5] ?? 0),
    };
}

export function compareVersions(left, right) {
    const stages = {alpha: 0n, beta: 1n, rc: 2n};
    const parts = (version) => [...version.core, stages[version.stage] ?? 3n, version.sequence];
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

export function assertDraft(tag, release, expectedId) {
    const version = parseVersion(tag);
    if (!tag.startsWith('v')) throw new Error('New release tags must start with v.');
    if (release.tag_name !== tag || (expectedId && String(release.id) !== expectedId)) {
        throw new Error('Release identity changed; refusing to write to a different release.');
    }
    if (release.draft !== true || release.published_at !== null) {
        throw new Error(`Release ${tag} is already published; use a new version.`);
    }
    if (release.prerelease !== (version.stage !== null)) {
        throw new Error(`Draft prerelease setting does not match ${tag}.`);
    }
    return version;
}

export function assertVersionIncrease(tag, releases) {
    const candidate = parseVersion(tag);
    for (const release of releases) {
        if (release.draft === true && release.published_at === null) continue;
        // Historical releases used an optional v prefix and sometimes had an incorrect
        // prerelease flag. The version itself determines the release channel.
        const published = parseVersion(release.tag_name);
        const sameCore = candidate.core.every((part, index) => part === published.core[index]);
        const relevant = published.stage === null || (candidate.stage !== null && sameCore);
        if (relevant && compareVersions(candidate, published) <= 0) {
            throw new Error(`${tag} must be newer than published release ${release.tag_name}.`);
        }
    }
}

export function verifyRelease({tag, repository, releaseId, draftOnly = false, run = execFileSync}) {
    parseVersion(tag);
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '')) {
        throw new Error('GITHUB_REPOSITORY must identify the release repository.');
    }
    if (releaseId !== undefined && !/^[1-9]\d*$/u.test(releaseId)) {
        throw new Error('Release ID must be a positive integer.');
    }
    const api = (args) => JSON.parse(run('gh', ['api', ...args], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }));
    const releasePath = releaseId ?? `tags/${encodeURIComponent(tag)}`;
    const release = api([`repos/${repository}/releases/${releasePath}`]);
    assertDraft(tag, release, releaseId);
    if (!draftOnly) {
        const pages = api(['--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]);
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
            throw new Error('Invalid paginated release history.');
        }
        assertVersionIncrease(tag, pages.flat());
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const {values, positionals} = parseArgs({
            allowPositionals: true,
            options: {'release-id': {type: 'string'}, 'draft-only': {type: 'boolean'}},
        });
        if (positionals.length !== 1) throw new Error('Provide one release tag.');
        verifyRelease({
            tag: positionals[0], repository: process.env.GITHUB_REPOSITORY,
            releaseId: values['release-id'], draftOnly: values['draft-only'],
        });
        console.log(`Release policy passed for ${positionals[0]}.`);
    } catch (error) {
        console.error(`[release-policy] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
