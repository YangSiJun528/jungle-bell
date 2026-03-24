import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { globSync } from 'node:fs';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir } from './utils.mjs';

const require = createRequire(import.meta.url);
const { runDefaultTransformationRules } = require('@wakaru/unminify');

const BATCH_SIZE = 10;

export async function unminify(debundledDir, outputDir) {
  const moduleFiles = globSync(join(debundledDir, '**/*.js').replace(/\\/g, '/'));
  assertNonEmpty(moduleFiles, 'UNMINIFY', 'debundled 내 모듈 파일');

  let successCount = 0;
  let failedCount = 0;
  const totalCount = moduleFiles.length;

  // 배치 처리
  for (let i = 0; i < moduleFiles.length; i += BATCH_SIZE) {
    const batch = moduleFiles.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (filePath) => {
        const originalCode = readFileSync(filePath, 'utf-8');
        if (!originalCode.trim()) return { filePath, skipped: true };

        const relPath = relative(debundledDir, filePath);
        const outPath = join(outputDir, relPath);

        const result = await runDefaultTransformationRules({
          source: originalCode,
          path: filePath,
        });

        const code = result.code;
        assert(code && code.length > 0, 'UNMINIFY', `빈 변환 결과: ${relPath}`);

        if (code === originalCode) {
          debug('UNMINIFY', `[WARN] 변환 없음: ${relPath}`);
        }

        await ensureDir(join(outPath, '..'));
        writeFileSync(outPath, code);
        return { filePath, success: true };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && !r.value?.skipped) {
        successCount++;
      } else if (r.status === 'rejected') {
        failedCount++;
        debug('UNMINIFY', `[WARN] 실패 skip: ${r.reason?.message}`);
      }
    }
  }

  // 성공률 검증
  if (totalCount > 0) {
    const successRate = successCount / totalCount;
    assert(successRate > 0.5, 'UNMINIFY', '50% 이상 실패 — wakaru 또는 prettier 패치 문제 확인 필요', {
      total: totalCount,
      success: successCount,
      failed: failedCount,
      successRate: `${(successRate * 100).toFixed(1)}%`,
    });
  }

  log('UNMINIFY', `완료: ${successCount}/${totalCount} 성공 (${failedCount}개 skip)`);
}
