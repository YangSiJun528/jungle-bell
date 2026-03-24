import { webcrack } from 'webcrack';
import { parse } from 'acorn';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir } from './utils.mjs';

export async function debundle(bundleDir, outputDir) {
  const files = readdirSync(bundleDir).filter(f => f.endsWith('.js'));
  assertNonEmpty(files, 'DEBUNDLE', 'raw-bundles 내 JS 파일');

  let totalModules = 0;
  let skipped = 0;

  for (const file of files) {
    const code = readFileSync(join(bundleDir, file), 'utf-8');
    const outDir = join(outputDir, basename(file, '.js'));

    try {
      // Turbopack 번들
      if (code.includes('globalThis.TURBOPACK')) {
        const modules = extractTurbopackModules(code);
        if (modules.length === 0) { skipped++; continue; }
        await ensureDir(outDir);
        for (const m of modules) writeFileSync(join(outDir, `${m.id}.js`), m.code);
        totalModules += modules.length;
        debug('DEBUNDLE', `${file}: turbopack ${modules.length}개`);
        continue;
      }

      // Webpack 번들
      const result = await webcrack(code, { deobfuscate: false });
      if (!result.bundle?.modules) { skipped++; continue; }
      const count = [...result.bundle.modules].length;
      if (count === 0) { skipped++; continue; }
      await ensureDir(outDir);
      await result.save(outDir);
      totalModules += count;
      debug('DEBUNDLE', `${file}: webpack ${count}개`);
    } catch (e) {
      log('DEBUNDLE', `[WARN] ${file} skip: ${e.message}`);
      skipped++;
    }
  }

  assert(totalModules > 0, 'DEBUNDLE', '모든 번들에서 모듈 추출 실패');
  log('DEBUNDLE', `완료: ${files.length}개 번들 → ${totalModules}개 모듈 (${skipped}개 skip)`);
}

// Turbopack: TURBOPACK.push([scriptRef, id, factory, ...]) 에서 모듈 추출
function extractTurbopackModules(code) {
  const ast = parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  const modules = [];

  walkNode(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.property?.name !== 'push') return;
    const elems = node.arguments[0]?.elements;
    if (!elems) return;

    for (let i = 1; i < elems.length; i++) {
      if (elems[i]?.type !== 'ArrowFunctionExpression') continue;
      const prev = elems[i - 1];
      const id = prev?.type === 'Literal' ? prev.value : `anon_${i}`;
      const params = elems[i].params.map(p => code.slice(p.start, p.end)).join(', ');
      const body = code.slice(elems[i].body.start, elems[i].body.end);
      modules.push({ id, code: `module.exports = function(${params}) ${body};` });
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
      for (const c of child) if (c?.type) walkNode(c, visitor);
    } else if (child?.type) {
      walkNode(child, visitor);
    }
  }
}
