import { chromium } from 'playwright';
import { writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir, BROWSER_DATA_DIR, RAW_BUNDLES_DIR } from './utils.mjs';

export async function collect(url, options = {}) {
  const { login = false } = options;

  await ensureDir(BROWSER_DATA_DIR);
  await ensureDir(RAW_BUNDLES_DIR);

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || await context.newPage();

  // --login: 수동 로그인 후 세션 저장
  if (login) {
    log('COLLECT', '브라우저가 열렸습니다. 구글 로그인 후 브라우저를 닫아주세요.');
    await page.goto(url, { waitUntil: 'networkidle' });
    await new Promise(resolve => context.on('close', resolve));
    log('COLLECT', '세션 저장 완료. --login 없이 다시 실행하세요.');
    return;
  }

  // JS 번들 수집
  const savedBundles = new Set();

  page.on('response', async (resp) => {
    const respUrl = resp.url();
    try {
      if (respUrl.includes('_next/static/chunks/') && respUrl.endsWith('.js')) {
        const name = basename(new URL(respUrl).pathname);
        if (savedBundles.has(name)) return;
        const body = await resp.body();
        writeFileSync(join(RAW_BUNDLES_DIR, name), body);
        savedBundles.add(name);
        debug('COLLECT', `번들: ${name} (${(body.length / 1024).toFixed(1)}KB)`);
      }
    } catch (e) {
      debug('COLLECT', `응답 처리 실패: ${respUrl} — ${e.message}`);
    }
  });

  log('COLLECT', `페이지 로드: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // 세션 만료 감지
  assert(
    !page.url().includes('/login') && !page.url().includes('accounts.google.com'),
    'COLLECT', '세션 만료. --login으로 재로그인 필요',
  );

  await page.waitForTimeout(3000);
  await context.close();

  const bundles = readdirSync(RAW_BUNDLES_DIR).filter(f => f.endsWith('.js'));
  assertNonEmpty(bundles, 'COLLECT', '수집된 JS 번들');
  log('COLLECT', `완료: 번들 ${bundles.length}개`);
}
