#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { assert } from './lib/assert.mjs';
import {
  log, setVerbose, ensureDir,
  OUTPUT_DIR, RAW_BUNDLES_DIR, DEBUNDLED_DIR, UNMINIFIED_DIR, API_MODULES_DIR, REPORT_PATH,
} from './lib/utils.mjs';
import { collect } from './lib/collector.mjs';
import { debundle } from './lib/debundler.mjs';
import { unminify } from './lib/unminifier.mjs';
import { extract } from './lib/extractor.mjs';
import { loadPreviousReport, diff, logChanges } from './lib/differ.mjs';
import { loadLatestSnapshot, saveSnapshot, saveChanges } from './lib/snapshotter.mjs';

function parseArgs(argv) {
  const args = { login: false, url: null, filter: null, verbose: false, help: false, snapshotRoot: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--login':          args.login = true; break;
      case '--verbose':        args.verbose = true; break;
      case '--help':           args.help = true; break;
      case '--url':            args.url = argv[++i] || null; break;
      case '--filter':         args.filter = (argv[++i] || '').split(',').filter(Boolean); break;
      case '--snapshot-root':  args.snapshotRoot = argv[++i] || null; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`사용법: node analyze.mjs --url <url> [--login] [--filter <apis>] [--verbose]`);
    process.exit(0);
  }

  assert(args.url, 'CLI', '--url은 필수입니다');
  assert(args.url.startsWith('http'), 'CLI', `유효하지 않은 URL: ${args.url}`);
  if (args.verbose) setVerbose(true);

  for (const dir of [OUTPUT_DIR, RAW_BUNDLES_DIR, DEBUNDLED_DIR, UNMINIFIED_DIR, API_MODULES_DIR]) {
    await ensureDir(dir);
  }

  log('PIPELINE', '① 데이터 수집');
  await collect(args.url, { login: args.login });

  log('PIPELINE', '② 디번들링');
  await debundle(RAW_BUNDLES_DIR, DEBUNDLED_DIR);

  log('PIPELINE', '③ Unminify');
  await unminify(DEBUNDLED_DIR, UNMINIFIED_DIR);

  log('PIPELINE', '④ API 모델 추출');
  const report = await extract(UNMINIFIED_DIR, API_MODULES_DIR, { filter: args.filter });

  // ⑤ 변경 감지 + 스냅샷 저장
  log('PIPELINE', '⑤ 변경 감지');
  if (args.snapshotRoot) {
    const logsDir = join(resolve(args.snapshotRoot), 'logs');
    const changesDir = join(resolve(args.snapshotRoot), 'changes');
    await ensureDir(logsDir);
    await ensureDir(changesDir);

    const previous = await loadLatestSnapshot(logsDir);
    const diffResult = diff(previous, report);
    logChanges(diffResult);

    const logPath = await saveSnapshot(report, logsDir);
    log('SNAPSHOT', `로그 저장: ${logPath}`);

    if (diffResult.hasChanges) {
      const changesPath = await saveChanges(diffResult, changesDir);
      log('SNAPSHOT', `변경 있음: ${diffResult.changes.length}건 → ${changesPath}`);
    } else {
      log('SNAPSHOT', '변경 없음');
    }
  } else {
    const previous = loadPreviousReport(REPORT_PATH);
    const diffResult = diff(previous, report);
    logChanges(diffResult);
  }

  log('PIPELINE', '완료');
}

main().catch(err => { console.error(err.message); process.exit(1); });
