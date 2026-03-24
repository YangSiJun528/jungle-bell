import { chromium } from 'playwright';
import { writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assert, assertNonEmpty } from './assert.mjs';
import { log, debug, ensureDir, BROWSER_DATA_DIR, RAW_BUNDLES_DIR, API_REQUESTS_PATH } from './utils.mjs';

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

  // 데이터 수집
  const apiResponses = {};
  const savedBundles = new Set();

  page.on('response', async (resp) => {
    const respUrl = resp.url();
    try {
      // JS 번들 저장
      if (respUrl.includes('_next/static/chunks/') && respUrl.endsWith('.js')) {
        const name = basename(new URL(respUrl).pathname);
        if (savedBundles.has(name)) return;
        const body = await resp.body();
        writeFileSync(join(RAW_BUNDLES_DIR, name), body);
        savedBundles.add(name);
        debug('COLLECT', `번들: ${name} (${(body.length / 1024).toFixed(1)}KB)`);
      }

      // API 요청+응답 캡처
      if (respUrl.includes('/api/v2/me/cohorts') && resp.status() === 200) {
        const parsed = new URL(respUrl);
        const req = resp.request();
        apiResponses[parsed.pathname] = {
          method: req.method(),
          queryString: parsed.search || null,
          requestHeaders: { contentType: req.headers()['content-type'] || null },
          postData: req.postData() || null,
          status: resp.status(),
          response: await resp.json(),
        };
        debug('COLLECT', `API: ${req.method()} ${parsed.pathname}`);
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
  writeFileSync(API_REQUESTS_PATH, JSON.stringify(apiResponses, null, 2));
  await context.close();

  // 최소 검증
  const bundles = readdirSync(RAW_BUNDLES_DIR).filter(f => f.endsWith('.js'));
  assertNonEmpty(bundles, 'COLLECT', '수집된 JS 번들');
  assert('/api/v2/me/cohorts' in apiResponses, 'COLLECT', 'cohorts API 미캡처');

  log('COLLECT', `완료: 번들 ${bundles.length}개, API ${Object.keys(apiResponses).length}개`);
}
