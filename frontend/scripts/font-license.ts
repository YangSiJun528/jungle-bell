import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const fontLicenseAssetPath = 'assets/fonts/Pretendard-LICENSE.txt';
export const fontLicenseSourcePath = resolve(
    import.meta.dirname,
    '../src/assets/fonts/Pretendard-LICENSE.txt',
);

export function verifyFontLicense(output: string) {
    const asset = resolve(output, fontLicenseAssetPath);
    if (!existsSync(asset)) throw new Error(`BUILD_ARTIFACT_MISSING:${fontLicenseAssetPath}`);
    if (!readFileSync(asset).equals(readFileSync(fontLicenseSourcePath))) {
        throw new Error(`BUILD_ARTIFACT_CONTENT_MISMATCH:${fontLicenseAssetPath}`);
    }
}
