/**
 * prettier 2.x ESM exports 필드 패치
 *
 * wakaru의 내부 의존성인 prettier 2.x가 package.json에 "exports" 필드가 없어
 * Node.js ESM 환경에서 모듈 해석 오류를 발생시킨다.
 * 이 스크립트는 postinstall 훅으로 실행되어 자동으로 패치한다.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prettierPkgPath = join(__dirname, '..', 'node_modules', 'prettier', 'package.json');

if (!existsSync(prettierPkgPath)) {
  console.log('[patch-prettier] prettier not found, skipping patch.');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(prettierPkgPath, 'utf-8'));

if (pkg.exports) {
  console.log('[patch-prettier] prettier already has exports field, skipping.');
  process.exit(0);
}

pkg.exports = {
  '.': './index.js',
  './*': './*.js',
};

writeFileSync(prettierPkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[patch-prettier] patched prettier/package.json with exports field.');
