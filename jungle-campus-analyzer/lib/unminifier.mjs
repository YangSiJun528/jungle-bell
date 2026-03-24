import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir } from './utils.mjs';

const require = createRequire(import.meta.url);
const { runDefaultTransformationRules } = require('@wakaru/unminify');

const BATCH_SIZE = 10;

export async function unminify(debundledDir, outputDir) {
  const files = globSync(join(debundledDir, '**/*.js').replace(/\\/g, '/'));
  assertNonEmpty(files, 'UNMINIFY', 'debundled 내 모듈 파일');

  let success = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (fp) => {
        const src = readFileSync(fp, 'utf-8');
        if (!src.trim()) return null;

        const out = join(outputDir, relative(debundledDir, fp));
        const result = await runDefaultTransformationRules({ source: src, path: fp });
        assert(result.code?.length > 0, 'UNMINIFY', `빈 변환 결과: ${fp}`);

        await ensureDir(join(out, '..'));
        writeFileSync(out, result.code);
        return true;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) success++;
      else if (r.status === 'rejected') {
        failed++;
        debug('UNMINIFY', `실패 skip: ${r.reason?.message}`);
      }
    }
  }

  assert(success / files.length > 0.5, 'UNMINIFY', '50% 이상 실패', {
    total: files.length, success, failed,
  });
  log('UNMINIFY', `완료: ${success}/${files.length} 성공 (${failed}개 skip)`);
}
