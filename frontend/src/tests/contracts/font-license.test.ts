import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';

import {expect, test} from 'vitest';

import {
    fontLicenseAssetPath,
    fontLicenseSourcePath,
    verifyFontLicense,
} from '../../../scripts/font-license';

test('font license artifact must exist and preserve the complete original', () => {
    const output = mkdtempSync(resolve(tmpdir(), 'jungle-bell-font-license-'));
    try {
        expect(() => verifyFontLicense(output)).toThrow('BUILD_ARTIFACT_MISSING:');
        const asset = resolve(output, fontLicenseAssetPath);
        mkdirSync(dirname(asset), {recursive: true});
        copyFileSync(fontLicenseSourcePath, asset);
        expect(() => verifyFontLicense(output)).not.toThrow();
        writeFileSync(asset, 'incomplete license');
        expect(() => verifyFontLicense(output)).toThrow('BUILD_ARTIFACT_CONTENT_MISMATCH:');
    } finally {
        rmSync(output, {recursive: true, force: true});
    }
});
