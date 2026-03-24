import { chromium } from 'playwright';
import { writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { assert, assertNonEmpty, assertHasKeys } from './assert.mjs';
import {
  log, debug, ensureDir,
  BROWSER_DATA_DIR, RAW_BUNDLES_DIR, API_REQUESTS_PATH,
} from './utils.mjs';

export async function collect(url, options = {}) {
  const { login = false, verbose = false } = options;

  await ensureDir(BROWSER_DATA_DIR);
  await ensureDir(RAW_BUNDLES_DIR);

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  // ── --login 모드: 수동 로그인 대기 ──
  if (login) {
    log('COLLECT', '브라우저가 열렸습니다. 구글 로그인을 수행한 뒤 브라우저를 닫아주세요.');
    await page.goto(url, { waitUntil: 'networkidle' });
    await new Promise(resolve => context.on('close', resolve));
    log('COLLECT', '세션이 저장되었습니다. 이제 --login 없이 실행하세요.');
    return;
  }

  // ── 데이터 수집 모드 ──
  const apiResponses = {};
  const savedBundles = new Set();

  page.on('response', async (response) => {
    const respUrl = response.url();
    try {
      // JS 번들 수집
      if (respUrl.includes('_next/static/chunks/') && respUrl.endsWith('.js')) {
        const filename = basename(new URL(respUrl).pathname);
        if (savedBundles.has(filename)) return;
        const body = await response.body();
        assert(body.length > 0, 'COLLECT', `빈 응답 body: ${respUrl}`);
        writeFileSync(join(RAW_BUNDLES_DIR, filename), body);
        savedBundles.add(filename);
        debug('COLLECT', `번들 저장: ${filename} (${(body.length / 1024).toFixed(1)}KB)`);
      }

      // API 요청+응답 캡처
      if (respUrl.includes('/api/v2/me/cohorts') && response.status() === 200) {
        const parsed = new URL(respUrl);
        const pathname = parsed.pathname;
        const request = response.request();
        const json = await response.json();
        apiResponses[pathname] = {
          method: request.method(),
          queryString: parsed.search || null,
          requestHeaders: { contentType: request.headers()['content-type'] || null },
          postData: request.postData() || null,
          status: response.status(),
          response: json,
        };
        debug('COLLECT', `API 캡처: ${request.method()} ${pathname}`);
      }
    } catch (e) {
      debug('COLLECT', `응답 처리 실패 (무시): ${respUrl} — ${e.message}`);
    }
  });

  log('COLLECT', `페이지 로드: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // 세션 만료 감지
  const currentUrl = page.url();
  assert(
    !currentUrl.includes('/login') && !currentUrl.includes('accounts.google.com'),
    'COLLECT',
    '세션이 만료되었습니다. --login으로 재로그인해주세요',
    { redirectedTo: currentUrl }
  );

  // 추가 네트워크 요청 대기
  await page.waitForTimeout(3000);

  // API 응답 저장
  writeFileSync(API_REQUESTS_PATH, JSON.stringify(apiResponses, null, 2));

  await context.close();

  // ── 출력 검증 ──
  const bundles = readdirSync(RAW_BUNDLES_DIR).filter(f => f.endsWith('.js'));
  assertNonEmpty(bundles, 'COLLECT', '수집된 JS 번들');

  for (const file of bundles) {
    const stat = statSync(join(RAW_BUNDLES_DIR, file));
    assert(stat.size > 0, 'COLLECT', `빈 번들 파일: ${file}`, { size: stat.size });
  }

  assert(existsSync(API_REQUESTS_PATH), 'COLLECT', 'api-requests.json 미생성');
  const apiData = JSON.parse(readFileSync(API_REQUESTS_PATH, 'utf-8'));
  assert('/api/v2/me/cohorts' in apiData, 'COLLECT', 'cohorts API 응답 미캡처', { keys: Object.keys(apiData) });

  const cohortsResponse = apiData['/api/v2/me/cohorts'].response;
  if (Array.isArray(cohortsResponse) && cohortsResponse.length > 0) {
    assertHasKeys(cohortsResponse[0], ['id', 'name', 'isActive'], 'COLLECT', 'cohorts 응답');
  }

  const attendanceKey = Object.keys(apiData).find(k => k.includes('/attendance/today'));
  if (attendanceKey) {
    assertHasKeys(apiData[attendanceKey].response, ['status', 'checkedAt', 'isStudying'], 'COLLECT', 'attendance 응답');
  }

  log('COLLECT', `수집 완료: JS 번들 ${bundles.length}개, API ${Object.keys(apiData).length}개`);
}
