#!/usr/bin/env node

import {readFileSync} from 'node:fs';

const repoRoot = new URL('../', import.meta.url);
const readSource = (path) => readFileSync(new URL(path, repoRoot), 'utf8');
const readJson = (path) => JSON.parse(readSource(path));

const matchedVersion = (path, pattern, label) => {
    const match = readSource(path).match(pattern);
    if (!match?.[1]) throw new Error(`${label} version was not found`);
    return match[1];
};

const tag = process.argv[2];
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/u;

try {
    const tagMatch = tag?.match(tagPattern);
    if (!tagMatch) {
        throw new Error('tag must match vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N');
    }

    const expectedVersion = tag.slice(1);
    const frontendPackage = readJson('frontend/package.json');
    const frontendPackageLock = readJson('frontend/package-lock.json');
    const tauriConfig = readJson('desktop/tauri.conf.json');
    const versions = new Map([
        ['frontend/package.json', frontendPackage.version],
        ['frontend/package-lock.json root', frontendPackageLock.version],
        ['frontend/package-lock.json workspace', frontendPackageLock.packages?.['']?.version],
        [
            'server/build.gradle.kts',
            matchedVersion(
                'server/build.gradle.kts',
                /allprojects\s*\{[\s\S]*?version\s*=\s*"([^"]+)"/u,
                'Gradle',
            ),
        ],
        [
            'desktop/Cargo.toml',
            matchedVersion(
                'desktop/Cargo.toml',
                /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/mu,
                'Cargo manifest',
            ),
        ],
        [
            'desktop/Cargo.lock',
            matchedVersion(
                'desktop/Cargo.lock',
                /\[\[package\]\]\nname = "jungle-bell"\nversion = "([^"]+)"/u,
                'Cargo lock',
            ),
        ],
        ['desktop/tauri.conf.json', tauriConfig.version],
    ]);

    for (const [label, version] of versions) {
        if (version !== expectedVersion) {
            throw new Error(`${label} has version ${String(version)}, expected ${expectedVersion}`);
        }
    }

    process.stdout.write(`${expectedVersion}\n`);
} catch (error) {
    console.error(`[release-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
