#!/usr/bin/env node

import { assert } from './lib/assert.mjs';
import {
  log, debug, setVerbose, ensureDir,
  OUTPUT_DIR, RAW_BUNDLES_DIR, DEBUNDLED_DIR,
  UNMINIFIED_DIR, API_MODULES_DIR,
} from './lib/utils.mjs';
import { collect } from './lib/collector.mjs';
import { debundle } from './lib/debundler.mjs';
import { unminify } from './lib/unminifier.mjs';
import { extract } from './lib/extractor.mjs';

// ── CLI 인자 파싱 ──────────────────────────────
function parseArgs(argv) {
  const args = { login: false, url: null, filter: null, verbose: false, help: false };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--login':   args.login = true; break;
      case '--verbose': args.verbose = true; break;
      case '--help':    args.help = true; break;
      case '--url':     args.url = argv[++i] || null; break;
      case '--filter':  args.filter = (argv[++i] || '').split(',').filter(Boolean); break;
      default:
        log('CLI', `알 수 없는 옵션 무시: ${argv[i]}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
사용법: node analyze.mjs [옵션]

옵션:
  --url <url>        (필수) 분석할 페이지 URL
  --login            수동 로그인 모드 (최초 1회 또는 세션 만료 시)
  --filter <apis>    쉼표 구분 API 경로 필터 (예: "/api/v2/me/cohorts,/attendance/today")
  --verbose          상세 디버그 로그 출력
  --help             이 도움말 출력

예시:
  node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in
  node analyze.mjs --url https://jungle-lms.krafton.com/check-in --verbose
`.trim());
}

// ── 메인 파이프라인 ────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // --url 필수 검증
  assert(args.url, 'CLI', '--url은 필수 옵션입니다');
  assert(args.url.startsWith('http'), 'CLI', `유효하지 않은 URL: ${args.url}`);

  if (args.verbose) setVerbose(true);

  log('CLI', `대상 URL: ${args.url}`);
  debug('CLI', `옵션: ${JSON.stringify(args)}`);

  // output 디렉토리 구조 생성
  for (const dir of [OUTPUT_DIR, RAW_BUNDLES_DIR, DEBUNDLED_DIR, UNMINIFIED_DIR, API_MODULES_DIR]) {
    await ensureDir(dir);
  }
  log('CLI', 'output 디렉토리 준비 완료');

  // ── Stage 1: 데이터 수집 ──
  log('PIPELINE', '① 데이터 수집 시작');
  await collect(args.url, { login: args.login, verbose: args.verbose });
  log('PIPELINE', '① 데이터 수집 완료');

  // ── Stage 2: 디번들링 ──
  log('PIPELINE', '② 번들 디번들링 시작');
  const debundleMeta = await debundle(RAW_BUNDLES_DIR, DEBUNDLED_DIR);
  log('PIPELINE', '② 번들 디번들링 완료');

  // ── Stage 3: Unminify ──
  log('PIPELINE', '③ 코드 가독성 복원 시작');
  await unminify(DEBUNDLED_DIR, UNMINIFIED_DIR);
  log('PIPELINE', '③ 코드 가독성 복원 완료');

  // ── Stage 4: 패턴 분석 ──
  log('PIPELINE', '④ 타겟 모듈 추출 + 패턴 분석 시작');
  const report = await extract(UNMINIFIED_DIR, API_MODULES_DIR, { filter: args.filter });
  log('PIPELINE', '④ 타겟 모듈 추출 + 패턴 분석 완료');

  log('PIPELINE', '모든 스테이지 완료');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
