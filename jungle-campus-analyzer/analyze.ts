#!/usr/bin/env node

import { resolve } from 'node:path';

import { loadConfig } from './lib/config.ts';
import { collectCurrentRun, loginAndPersistSession } from './lib/collector.ts';
import { diffReports, logChanges } from './lib/differ.ts';
import { buildObserverReport } from './lib/report.ts';
import { loadLatestSnapshot, saveChanges, saveSnapshot } from './lib/snapshotter.ts';
import { extractStaticContracts } from './lib/static-extractor.ts';
import type { CollectionResult } from './lib/types.ts';
import {
  DEFAULT_CONFIG_PATH,
  REPORT_PATH,
  loadBundlesFromDirectory,
  log,
  readObserverReport,
  setVerbose,
  writeJson,
} from './lib/utils.ts';

interface CliArguments {
  artifactDir: string | null;
  bundleDir: string | null;
  configPath: string;
  help: boolean;
  login: boolean;
  routes: string[];
  snapshotRoot: string | null;
  url: string | null;
  verbose: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  setVerbose(args.verbose);
  const config = await loadConfig(args.configPath);

  if (args.login) {
    if (args.bundleDir) throw new Error('--login과 --bundle-dir은 함께 사용할 수 없습니다.');
    await loginAndPersistSession(config, args.url);
    return;
  }

  const collection = args.bundleDir
    ? await collectOffline(args.bundleDir)
    : await collectCurrentRun(config, {
        entryUrl: args.url,
        routes: args.routes,
        artifactDir: args.artifactDir,
      });
  if (collection.bundles.length === 0) throw new Error('분석할 JavaScript 번들을 찾지 못했습니다.');

  log('ANALYZE', `Oxc로 현재 번들 ${collection.bundles.length}개 정적 분석`);
  const staticResult = extractStaticContracts(collection.bundles, {
    relativeApiBasePath: config.relativeApiBasePath,
  });
  if (Object.keys(staticResult.endpoints).length === 0) {
    throw new Error('현재 번들에서 API 엔드포인트를 찾지 못했습니다. 오래된 결과를 재사용하지 않고 실패로 종료합니다.');
  }

  const report = buildObserverReport({ config, staticResult, collection });
  const snapshotPaths = args.snapshotRoot ? snapshotDirectories(args.snapshotRoot) : null;
  const previous = snapshotPaths
    ? await loadLatestSnapshot(snapshotPaths.logs)
    : await readObserverReport(REPORT_PATH);
  const diff = diffReports(previous, report);

  await writeJson(REPORT_PATH, report);
  log('REPORT', `엔드포인트 ${Object.keys(report.endpoints).length}개, ENUM 후보 ${report.enums.length}개`);
  log('REPORT', `현재 결과: ${REPORT_PATH}`);
  logChanges(diff);

  if (snapshotPaths) {
    const snapshotPath = await saveSnapshot(report, snapshotPaths.logs);
    log('SNAPSHOT', `검토 기준 저장: ${snapshotPath}`);
    if (diff.hasChanges && !diff.firstRun) {
      const changePath = await saveChanges(diff, snapshotPaths.changes);
      log('SNAPSHOT', `검토할 변경 ${diff.changes.length}건: ${changePath}`);
    } else if (diff.firstRun) {
      log('SNAPSHOT', '첫 실행은 기준만 저장하고 변경 파일은 만들지 않습니다.');
    }
  }

  for (const warning of report.warnings) console.warn(`[WARN] ${warning}`);
}

async function collectOffline(directory: string): Promise<CollectionResult> {
  const bundles = await loadBundlesFromDirectory(resolve(directory));
  log('COLLECT', `오프라인 번들 ${bundles.length}개 로드: ${resolve(directory)}`);
  return { visitedRoutes: [], bundles, exchanges: [] };
}

function snapshotDirectories(root: string): { logs: string; changes: string } {
  const directory = resolve(root);
  return { logs: resolve(directory, 'logs'), changes: resolve(directory, 'changes') };
}

function parseArguments(argv: string[]): CliArguments {
  const result: CliArguments = {
    artifactDir: null,
    bundleDir: null,
    configPath: DEFAULT_CONFIG_PATH,
    help: false,
    login: false,
    routes: [],
    snapshotRoot: null,
    url: null,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case '--artifacts': result.artifactDir = requiredValue(argv, ++index, argument); break;
      case '--bundle-dir': result.bundleDir = requiredValue(argv, ++index, argument); break;
      case '--config': result.configPath = resolve(requiredValue(argv, ++index, argument)); break;
      case '--help': result.help = true; break;
      case '--login': result.login = true; break;
      case '--route': result.routes.push(requiredValue(argv, ++index, argument)); break;
      case '--snapshot-root': result.snapshotRoot = requiredValue(argv, ++index, argument); break;
      case '--url': result.url = requiredValue(argv, ++index, argument); break;
      case '--verbose': result.verbose = true; break;
      default: throw new Error(`알 수 없는 옵션: ${argument ?? '(empty)'}`);
    }
  }
  return result;
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} 뒤에 값이 필요합니다.`);
  return value;
}

function printHelp(): void {
  console.log(`Jungle Campus API 관찰기

사용법:
  npm run login
  npm run analyze -- [options]

옵션:
  --config <file>          설정 파일 (기본: observer.config.json)
  --url <url>              첫 방문 URL을 일시적으로 변경
  --route <path>           추가로 방문할 경로 (반복 가능)
  --snapshot-root <dir>    logs/ 기준 스냅샷과 changes/ 변경점 저장
  --bundle-dir <dir>       브라우저 없이 로컬 JS 번들만 분석
  --artifacts <dir>        문제 진단용으로 현재 실행 번들만 저장
  --login                  수동 로그인 세션 저장
  --verbose                상세 수집 로그
  --help                   도움말`);
}

main().catch((error: unknown) => {
  console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
