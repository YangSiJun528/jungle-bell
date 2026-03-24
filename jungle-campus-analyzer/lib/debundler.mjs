import { webcrack } from 'webcrack';
import { parse } from 'acorn';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir } from './utils.mjs';

// ── Turbopack 디번들러 ─────────────────────────
function isTurbopackBundle(code) {
  return code.includes('globalThis.TURBOPACK');
}

function extractTurbopackModules(code, sourceFile) {
  const ast = parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  const modules = [];

  // AST를 순회하여 TURBOPACK.push([...]) 호출을 찾음
  walkNode(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      node.callee.property?.name === 'push'
    ) {
      const arg = node.arguments[0];
      if (arg?.type !== 'ArrayExpression') return;

      const elems = arg.elements;
      // 첫 번째 요소는 scriptRef, 이후 요소를 순회하며
      // ArrowFunction 직전의 Literal을 모듈 ID로 사용
      // (일부 번들은 [id1, id2, factory] 형태로 ID가 연속될 수 있음)
      for (let i = 1; i < elems.length; i++) {
        const el = elems[i];
        if (el?.type !== 'ArrowFunctionExpression') continue;

        // 직전 Literal을 모듈 ID로 사용
        const prev = elems[i - 1];
        const moduleId = prev?.type === 'Literal' ? prev.value : `anon_${i}`;
        // 팩토리 함수 전체를 모듈로 추출 (파라미터 포함)
        // (e, t, n) => { ... } 를 module.exports = function(e, t, n) { ... } 형태로 감싸서
        // 파서가 올바른 스코프 분석을 할 수 있도록 함
        const params = el.params.map(p => code.slice(p.start, p.end)).join(', ');
        const body = code.slice(el.body.start, el.body.end);
        const moduleCode = `module.exports = function(${params}) ${body};`;
        modules.push({ id: moduleId, code: moduleCode });
      }
    }
  });

  return modules;
}

function walkNode(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) { if (c?.type) walkNode(c, visitor); }
    } else if (child?.type) {
      walkNode(child, visitor);
    }
  }
}

// ── 메인 디번들 함수 ──────────────────────────
export async function debundle(bundleDir, outputDir) {
  const bundleFiles = readdirSync(bundleDir).filter(f => f.endsWith('.js'));
  assertNonEmpty(bundleFiles, 'DEBUNDLE', 'raw-bundles 내 JS 파일');

  const meta = { totalBundles: bundleFiles.length, totalModules: 0, skippedBundles: 0, bundleMap: {} };

  for (const file of bundleFiles) {
    const filePath = join(bundleDir, file);
    const code = readFileSync(filePath, 'utf-8');
    const bundleName = basename(file, '.js');
    const outDir = join(outputDir, bundleName);

    try {
      // Turbopack 번들 감지 → 전용 파서 사용
      if (isTurbopackBundle(code)) {
        const modules = extractTurbopackModules(code, file);
        if (modules.length === 0) {
          debug('DEBUNDLE', `turbopack 런타임 전용 skip: ${file}`);
          meta.skippedBundles++;
          continue;
        }

        await ensureDir(outDir);
        for (const mod of modules) {
          writeFileSync(join(outDir, `${mod.id}.js`), mod.code);
        }

        meta.totalModules += modules.length;
        meta.bundleMap[file] = { type: 'turbopack', modules: modules.length, outputDir: outDir };
        debug('DEBUNDLE', `${file}: turbopack, ${modules.length}개 모듈`);
        continue;
      }

      // Webpack 번들 → webcrack 사용
      const result = await webcrack(code, { deobfuscate: false });

      if (!result.bundle || !result.bundle.modules) {
        debug('DEBUNDLE', `비-webpack 번들 skip: ${file}`);
        meta.skippedBundles++;
        continue;
      }

      const moduleCount = [...result.bundle.modules].length;
      if (moduleCount === 0) {
        debug('DEBUNDLE', `모듈 0개 skip: ${file}`);
        meta.skippedBundles++;
        continue;
      }

      await ensureDir(outDir);
      await result.save(outDir);

      meta.totalModules += moduleCount;
      meta.bundleMap[file] = { type: result.bundle.type, modules: moduleCount, outputDir: outDir };
      debug('DEBUNDLE', `${file}: ${result.bundle.type}, ${moduleCount}개 모듈`);
    } catch (e) {
      log('DEBUNDLE', `[WARN] ${file} 처리 실패 skip: ${e.message}`);
      meta.skippedBundles++;
    }
  }

  // 최소 1개 번들에서 모듈 추출 성공
  assert(meta.totalModules > 0, 'DEBUNDLE', '모든 번들에서 모듈 추출 실패', {
    totalBundles: meta.totalBundles,
    skipped: meta.skippedBundles,
  });

  // 추출된 모듈이 번들보다 많아야 함
  assert(meta.totalModules >= (meta.totalBundles - meta.skippedBundles), 'DEBUNDLE',
    '모듈 수가 번들 수보다 적음 — 디번들링 이상', {
      totalBundles: meta.totalBundles,
      totalModules: meta.totalModules,
    });

  log('DEBUNDLE', `완료: ${meta.totalBundles}개 번들 → ${meta.totalModules}개 모듈 (${meta.skippedBundles}개 skip)`);
  return meta;
}
