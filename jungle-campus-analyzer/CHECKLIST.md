# Jungle Campus API 변경 감지 분석기 — 구현 체크리스트

> 기술 명세: [TODO_Mock-Jungle-Campus.md](../TODO_Mock-Jungle-Campus.md)
>
> 각 Phase는 독립적으로 검증 가능하며, 이전 Phase 완료 후 다음으로 진행한다.

---

## 검증 전략: 내장 Assert

별도 테스트 프레임워크 없이, **각 함수 내부에 입출력 assert를 내장**한다. 실패 시 즉시 에러 메시지와 함께 프로세스가 중단되므로 문제를 빠르게 파악할 수 있다.

### 공용 assert 헬퍼 (`lib/assert.mjs`)

```javascript
// 조건 실패 시 stage 이름 + 메시지를 포함한 에러를 throw
export function assert(condition, stage, message, context = {}) {
  if (!condition) {
    const detail = Object.keys(context).length
      ? '\n' + JSON.stringify(context, null, 2)
      : '';
    throw new Error(`[${stage}] Assertion failed: ${message}${detail}`);
  }
}

// 값이 특정 타입인지 확인
export function assertType(value, type, stage, label) {
  assert(typeof value === type, stage, `${label}의 타입이 ${type}이어야 함 (실제: ${typeof value})`);
}

// 배열이 비어있지 않은지 확인
export function assertNonEmpty(arr, stage, label) {
  assert(Array.isArray(arr) && arr.length > 0, stage, `${label}이 비어있음`, { length: arr?.length });
}

// 파일이 존재하는지 확인
export function assertFileExists(filePath, stage) {
  assert(existsSync(filePath), stage, `파일 미존재: ${filePath}`);
}

// 객체가 필수 키를 포함하는지 확인
export function assertHasKeys(obj, keys, stage, label) {
  const missing = keys.filter(k => !(k in obj));
  assert(missing.length === 0, stage, `${label}에 필수 키 누락`, { missing, actual: Object.keys(obj) });
}
```

### 적용 원칙

1. **입력 검증**: 각 스테이지 함수 진입 시 입력 데이터의 존재·타입·형식을 assert
2. **출력 검증**: 각 스테이지 함수 완료 후 결과물의 무결성을 assert
3. **스테이지 간 계약**: 이전 스테이지의 출력이 다음 스테이지의 입력 조건을 충족하는지 assert
4. **실패 시**: 스테이지 이름 + 구체적 사유 + 관련 데이터를 포함한 에러 즉시 throw

---

## Phase 0: 프로젝트 스캐폴딩

**목표:** Tauri 프로젝트에 영향 없는 독립 Node.js 프로젝트 생성

### 0-1. Vite로 프로젝트 초기화

```bash
# 프로젝트 루트에서 실행
npm create vite@latest jungle-campus-analyzer -- --template vanilla
```

- [x] Vite `vanilla` 템플릿으로 프로젝트 생성
- [x] Vite 생성 후 불필요한 파일 정리 (웹 관련 파일 제거)
  - 삭제: `index.html`, `counter.js`, `javascript.svg`, `public/`, `style.css`, `main.js`
  - `vite.config.js` 불필요 시 삭제

### 0-2. 프로젝트 커스터마이징

- [x] `package.json` 수정
  - `"type": "module"` 확인 (Vite 기본 설정)
  - dependencies 추가: `playwright ^1.50`, `webcrack ^2.15`, `@wakaru/unminify ^0.2`, `@wakaru/unpacker ^0.1`
  - devDependencies에서 `vite` 제거 (CLI 전용)
  - scripts에 `"postinstall": "node scripts/patch-prettier.mjs"` 추가
  - scripts에 `"analyze": "node analyze.mjs"`, `"login": "node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in"` 추가
  - `overrides`에 `"isolated-vm": "^6.0.0"` 추가 (Node 25 호환)
- [x] `scripts/patch-prettier.mjs` 작성 — prettier 2.x `exports` 필드 패치
- [x] `.gitignore` 수정 — 기존 Vite 항목에 `.browser-data/`, `output/` 추가
- [x] 루트 `.gitignore`에 분석기 관련 경로 추가

### 0-3. 소스 파일 구조 생성

- [x] 스텁 파일 생성:
  - `analyze.mjs` — CLI 진입점
  - `lib/assert.mjs` — 공용 assert 헬퍼
  - `lib/utils.mjs`
  - `lib/collector.mjs`
  - `lib/debundler.mjs`
  - `lib/unminifier.mjs`
  - `lib/extractor.mjs`
  - `lib/differ.mjs`

### 검증

- [x] `npm install` 에러 없이 완료
- [x] `node_modules/playwright`, `node_modules/webcrack` 존재
- [x] prettier postinstall 패치: `node_modules/prettier/package.json`에 `exports` 필드 포함
- [x] `node -e "import('./analyze.mjs')"` ESM import 에러 없음

---

## Phase 1: CLI 진입점 + 유틸리티

**목표:** CLI 인자 파싱과 파이프라인 오케스트레이션 뼈대 완성

- [x] `analyze.mjs` — CLI 인자 파싱
  - `--login` (boolean): 수동 로그인 모드
  - `--url <url>` (required): 대상 페이지 URL
  - `--diff` (boolean): 이전 스냅샷과 비교
  - `--filter <apis>` (optional): 쉼표 구분 API 경로 필터
  - `--verbose` (boolean): 디버그 로깅
  - `--help`: 사용법 출력
- [x] `lib/utils.mjs` — 공용 헬퍼
  - `ensureDir(path)` — `fs.mkdir({ recursive: true })`
  - `log(stage, message)` — `[STAGE] message` 형식
  - `writeJson(path, data)` / `readJson(path)`
  - 경로 상수: `OUTPUT_DIR`, `BROWSER_DATA_DIR`, 하위 디렉토리
- [x] 파이프라인 오케스트레이션 — 각 스테이지를 순서대로 호출 (현재는 스텁)

### 내장 Assert

`analyze.mjs` 진입 시:
```javascript
// --url 필수 검증
assert(args.url, 'CLI', '--url은 필수 옵션입니다');

// URL 형식 검증
assert(args.url.startsWith('http'), 'CLI', `유효하지 않은 URL: ${args.url}`);
```

`lib/utils.mjs` 각 함수:
```javascript
// ensureDir 후 디렉토리 존재 확인
await fs.mkdir(dirPath, { recursive: true });
assert(existsSync(dirPath), 'UTILS', `디렉토리 생성 실패: ${dirPath}`);

// writeJson 후 파일 존재 + 내용 검증
await fs.writeFile(filePath, JSON.stringify(data, null, 2));
assert(existsSync(filePath), 'UTILS', `JSON 파일 쓰기 실패: ${filePath}`);

// readJson 반환값 검증 (파일 존재 시 null이 아닌 객체)
if (existsSync(filePath)) {
  const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  assertType(data, 'object', 'UTILS', `readJson(${filePath})`);
}
```

파이프라인 오케스트레이션:
```javascript
// output 디렉토리 구조 생성 후 검증
for (const dir of [RAW_BUNDLES_DIR, DEBUNDLED_DIR, UNMINIFIED_DIR, API_MODULES_DIR, SNAPSHOTS_DIR]) {
  await ensureDir(dir);
}
```

### 검증

- [x] `node analyze.mjs` (--url 없이) → `"--url은 필수 옵션입니다"` 에러 + exit code ≠ 0
- [x] `node analyze.mjs --url not-a-url` → URL 형식 에러
- [x] `node analyze.mjs --help` → 사용법 출력 + exit code 0
- [x] `node analyze.mjs --url https://example.com` → `output/` 하위 디렉토리 생성 + 스테이지 로그 순서대로 출력

---

## Phase 2: 데이터 수집 (Playwright)

**목표:** 인증된 브라우저로 JS 번들, API 응답, SSR 데이터 수집

### 사전 준비
- [ ] `npx playwright install chromium` 실행

### 구현
- [x] `lib/collector.mjs` — `export async function collect(url, options)`
  - [x] Persistent context: `chromium.launchPersistentContext('.browser-data/', { headless: false, args: ['--disable-blink-features=AutomationControlled'] })`
  - [x] `--login` 모드: 브라우저 열기 → 콘솔에 "로그인 후 브라우저를 닫아주세요" 안내 → 수동 로그인 대기 → 세션 자동 저장
- [x] 응답 인터셉션 (`page.on('response')`)
  - [x] `_next/static/chunks/*.js` → `output/raw-bundles/{filename}` 저장
  - [x] `/api/v2/me/cohorts` 응답 → `output/api-requests.json`
  - [x] `/api/v2/me/cohorts/*/attendance/today` 응답 → 같은 파일
- [x] `__NEXT_DATA__` 추출: `page.evaluate(() => window.__NEXT_DATA__)` → `output/next-data.json`
- [x] 세션 만료 감지: URL이 로그인 페이지로 리다이렉트되면 에러 + 안내 메시지

### 내장 Assert

수집 완료 후 (collect 함수 반환 직전):
```javascript
// JS 번들이 1개 이상 수집되었는지
const bundles = readdirSync(RAW_BUNDLES_DIR).filter(f => f.endsWith('.js'));
assertNonEmpty(bundles, 'COLLECT', '수집된 JS 번들');

// 각 번들 파일 크기 > 0
for (const file of bundles) {
  const stat = statSync(join(RAW_BUNDLES_DIR, file));
  assert(stat.size > 0, 'COLLECT', `빈 번들 파일: ${file}`, { size: stat.size });
}

// API 응답 캡처 확인
assert(existsSync(API_REQUESTS_PATH), 'COLLECT', 'api-requests.json 미생성');
const apiData = JSON.parse(readFileSync(API_REQUESTS_PATH, 'utf-8'));
assert('/api/v2/me/cohorts' in apiData, 'COLLECT', 'cohorts API 응답 미캡처', { keys: Object.keys(apiData) });

// cohorts 응답 필수 필드
const cohorts = apiData['/api/v2/me/cohorts'];
if (Array.isArray(cohorts) && cohorts.length > 0) {
  assertHasKeys(cohorts[0], ['id', 'name', 'isActive'], 'COLLECT', 'cohorts 응답');
}

// attendance 응답이 캡처된 경우 필수 필드 확인
const attendanceKey = Object.keys(apiData).find(k => k.includes('/attendance/today'));
if (attendanceKey) {
  assertHasKeys(apiData[attendanceKey], ['status', 'checkedAt', 'isStudying'], 'COLLECT', 'attendance 응답');
}

// __NEXT_DATA__ 존재 확인
assert(existsSync(NEXT_DATA_PATH), 'COLLECT', 'next-data.json 미생성');
```

세션 만료 감지:
```javascript
// 페이지 로드 후 URL 확인
const currentUrl = page.url();
assert(
  !currentUrl.includes('/login') && !currentUrl.includes('accounts.google.com'),
  'COLLECT',
  '세션이 만료되었습니다. --login으로 재로그인해주세요',
  { redirectedTo: currentUrl }
);
```

응답 인터셉션 필터:
```javascript
page.on('response', async (response) => {
  const url = response.url();
  // JS 번들만 수집 (이미지, CSS 등 제외)
  if (url.includes('_next/static/chunks/') && url.endsWith('.js')) {
    const body = await response.body();
    assert(body.length > 0, 'COLLECT', `빈 응답 body: ${url}`);
    // ... 저장
  }
});
```

### 검증 (수동 — 외부 서비스 의존)

- [ ] `node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in` → 브라우저 열림, 수동 로그인 후 세션 저장
- [ ] `node analyze.mjs --url https://jungle-lms.krafton.com/check-in` → assert 에러 없이 완료
- [ ] `.browser-data/` 삭제 후 실행 → 세션 만료 assert 에러 메시지

---

## Phase 3: 번들 디번들링 (webcrack)

**목표:** Webpack 번들을 개별 모듈로 분리

- [x] `lib/debundler.mjs` — `export async function debundle(bundleDir, outputDir)`
  - [x] `output/raw-bundles/*.js` 순회
  - [x] `webcrack(code, { deobfuscate: false })` 호출
  - [x] `result.save()` → `output/debundled/{bundle-name}/`
- [x] 비-webpack 번들 오류 처리 — catch하고 로그 후 skip
- [x] 메타데이터 반환: `{ totalBundles, totalModules, bundleMap }`

### 내장 Assert

입력 검증:
```javascript
// raw-bundles 디렉토리에 처리할 파일이 있는지
const bundleFiles = readdirSync(bundleDir).filter(f => f.endsWith('.js'));
assertNonEmpty(bundleFiles, 'DEBUNDLE', 'raw-bundles 내 JS 파일');
```

각 번들 처리 후:
```javascript
// webcrack 결과가 유효한지 (비-webpack 번들은 catch → skip이므로 여기에 도달하면 성공)
assert(result.modules.length > 0, 'DEBUNDLE', `모듈 0개: ${bundleFile}`, {
  bundleSize: code.length,
  type: result.type  // 'webpack' | 'browserify' | ...
});
```

전체 완료 후:
```javascript
// 최소 1개 번들에서 모듈 추출 성공
assert(meta.totalModules > 0, 'DEBUNDLE', '모든 번들에서 모듈 추출 실패', {
  totalBundles: meta.totalBundles,
  skipped: meta.skippedBundles
});

// 추출된 모듈이 번들보다 많아야 함 (1개 번들 = 여러 모듈)
assert(meta.totalModules >= meta.totalBundles, 'DEBUNDLE', '모듈 수가 번들 수보다 적음 — 디번들링 이상', {
  totalBundles: meta.totalBundles,
  totalModules: meta.totalModules
});

log('DEBUNDLE', `완료: ${meta.totalBundles}개 번들 → ${meta.totalModules}개 모듈`);
```

### 검증

- [ ] Phase 2 완료 후 파이프라인 실행 → assert 에러 없이 `output/debundled/` 생성
- [ ] 비-webpack 파일 존재 시 skip 로그 + 프로세스 중단 없음
- [ ] `totalModules >= totalBundles` assert 통과

---

## Phase 4: 코드 가독성 복원 (wakaru)

**목표:** Minified 코드의 가독성 복원, 특히 TypeScript ENUM 패턴

### 사전 확인
- [x] `npm install` 후 prettier postinstall 패치 동작 확인

### 구현
- [x] `lib/unminifier.mjs` — `export async function unminify(debundledDir, outputDir)`
  - [x] `output/debundled/**/*.js` 재귀 읽기
  - [x] wakaru `runDefaultTransformationRules` 호출 (`createRequire` CJS 워커라운드)
  - [x] `output/unminified/` 에 동일 디렉토리 구조로 저장
- [x] 동시성 제어: 10개 파일 단위 배치 처리 (`Promise.allSettled` 청킹)
- [x] 파일별 오류 처리 — 실패 시 skip + 경고 로그

### 내장 Assert

입력 검증:
```javascript
// debundled 디렉토리에 모듈 파일이 있는지
const moduleFiles = globSync(join(debundledDir, '**/*.js'));
assertNonEmpty(moduleFiles, 'UNMINIFY', 'debundled 내 모듈 파일');
```

각 파일 처리 후:
```javascript
// 변환 결과가 비어있지 않은지
assert(result.length > 0, 'UNMINIFY', `빈 변환 결과: ${filePath}`);

// 결과가 원본과 다른지 (최소한의 변환이 적용되었는지) — 경고만, throw 안 함
if (result === originalCode) {
  log('UNMINIFY', `[WARN] 변환 없음: ${filePath} (이미 unminify된 코드일 수 있음)`);
}
```

전체 완료 후:
```javascript
// 처리 통계
const successRate = successCount / totalCount;
assert(successRate > 0.5, 'UNMINIFY', '50% 이상 실패 — wakaru 또는 prettier 패치 문제 확인 필요', {
  total: totalCount,
  success: successCount,
  failed: failedCount,
  successRate: `${(successRate * 100).toFixed(1)}%`
});

log('UNMINIFY', `완료: ${successCount}/${totalCount} 성공 (${failedCount}개 skip)`);
```

### 검증

- [ ] Phase 3 완료 후 파이프라인 실행 → 성공률 50% 이상 assert 통과
- [ ] 실패 파일은 경고 로그 + skip, 프로세스 중단 없음
- [ ] `output/unminified/` 디렉토리 구조가 `output/debundled/`와 대응

---

## Phase 5: 타겟 모듈 추출 + 패턴 분석

**목표:** API 관련 모듈만 필터링하고 ENUM·조건 분기·에러 핸들링 추출

### 모듈 필터링
- [x] Primary 키워드 검색: `"/api/v2/me/cohorts"`, `"/attendance/today"`
- [x] Secondary 키워드 검색: `"PRESENT"`, `"ABSENT"`, `"LATE"`, `"status"`, `"checkedAt"`, `"checkedOutAt"`, `"isStudying"`, `"isActive"`, `"cohortClassId"`, `"cohortClassName"`, `"enrolledAt"`
- [x] 매칭 기준: primary ≥ 1 OR secondary ≥ 2
- [x] 매칭 모듈 → `output/api-modules/` 복사

### ENUM 추출 (정규식)
- [x] 패턴 1 — 객체 리터럴: `{ PRESENT: "PRESENT", ... }`
- [x] 패턴 2 — IIFE 미복원: `n["PRESENT"]="PRESENT"`
- [x] 패턴 3 — switch/case: `case "PRESENT":`
- [x] 패턴 4 — 동등 비교: `=== "PRESENT"`

### 추가 분석
- [x] 조건 분기 추출: `status === "VALUE"` 주변 ±5줄 컨텍스트
- [x] 에러 핸들링 추출: `.catch(`, `status === 401/404` 패턴
- [x] API 응답 스키마 추론 (`api-requests.json` 기반)
  - 필드명, 타입, nullable, 날짜 형식(ISO 8601), CUID 패턴

### 리포트 생성
- [x] `output/api-modules/report.json` 생성 — 기술 명세 §4.4 스키마 준수
  - `apis[path].capturedResponse`
  - `apis[path].responseFields`
  - `apis[path].fieldTypes`
  - `apis[path].enums`
  - `apis[path].conditionalBranches`
  - `apis[path].errorHandling`
  - `apis[path].relatedModules`

### 내장 Assert

모듈 필터링 후:
```javascript
// 매칭된 모듈이 1개 이상인지
const matchedModules = filterModules(allModules, PRIMARY_KEYWORDS, SECONDARY_KEYWORDS);
assertNonEmpty(matchedModules, 'EXTRACT', 'API 관련 모듈 — 키워드 매칭 결과 0건', {
  totalScanned: allModules.length,
  primaryKeywords: PRIMARY_KEYWORDS,
  secondaryKeywords: SECONDARY_KEYWORDS
});

log('EXTRACT', `${allModules.length}개 모듈 중 ${matchedModules.length}개 매칭`);
```

ENUM 추출 후:
```javascript
// status ENUM이 추출되었는지 (핵심 목표)
const statusEnums = extractedEnums.status?.foundValues || [];
assert(statusEnums.length > 0, 'EXTRACT',
  'status ENUM 값을 1개도 찾지 못함 — 정규식 패턴 또는 코드 구조 변경 확인 필요', {
    searchedPatterns: ['객체 리터럴', 'IIFE', 'switch/case', '동등 비교'],
    matchedModuleCount: matchedModules.length
  }
);

// PRESENT는 반드시 포함되어야 함 (API 응답에서 이미 확인된 값)
assert(statusEnums.includes('PRESENT'), 'EXTRACT',
  'PRESENT가 ENUM에 미포함 — 추출 로직 오류', { foundValues: statusEnums }
);

log('EXTRACT', `status ENUM 발견: [${statusEnums.join(', ')}]`);
```

API 응답 스키마 추론:
```javascript
// 캡처된 응답에서 필드 타입 추론
for (const [apiPath, response] of Object.entries(apiResponses)) {
  const fields = Object.keys(response);
  assertNonEmpty(fields, 'EXTRACT', `${apiPath} 응답에 필드 없음`);

  for (const [field, value] of Object.entries(response)) {
    const inferredType = inferType(value);
    assertType(inferredType, 'string', 'EXTRACT', `${apiPath}.${field} 타입 추론 결과`);
  }
}
```

report.json 생성 직전 (스키마 자기 검증):
```javascript
// report 필수 구조 검증
assertHasKeys(report, ['timestamp', 'apis'], 'EXTRACT', 'report 최상위');
assertType(report.timestamp, 'string', 'EXTRACT', 'report.timestamp');

for (const [path, api] of Object.entries(report.apis)) {
  assertHasKeys(api,
    ['capturedResponse', 'responseFields', 'fieldTypes', 'enums', 'relatedModules'],
    'EXTRACT', `report.apis["${path}"]`
  );
  assert(Array.isArray(api.responseFields), 'EXTRACT', `${path}.responseFields는 배열이어야 함`);
  assert(Array.isArray(api.relatedModules), 'EXTRACT', `${path}.relatedModules는 배열이어야 함`);
}

log('EXTRACT', 'report.json 스키마 검증 통과');
```

### 검증

- [ ] 전체 파이프라인 실행 → 모든 assert 통과
- [ ] `report.json`에 `status` ENUM 값 목록 포함 (`PRESENT` 필수)
- [ ] 스키마 자기 검증으로 필수 필드 누락 즉시 감지

---

## Phase 6: Diff + 스냅샷 + 알림

**목표:** 이전 실행 결과와 비교하여 API 변경 감지

### 스냅샷 관리
- [x] `snapshot(report, snapshotsDir)` — 타임스탬프 파일 저장 + `latest.json` 갱신
- [x] 스냅샷 파일명: `snapshot-{YYYY-MM-DDTHH-mm-ss}.json`

### Diff 로직
- [x] 필드 변경: `responseFields` Set diff → 추가/삭제 감지
- [x] 타입 변경: `fieldTypes` 값 비교
- [x] ENUM 변경: `enums.*.foundValues` Set diff
- [x] 로직 변경: 관련 모듈 코드 해시(SHA-256) 비교

### 알림
- [x] `notify(diffResult)` — 더미 구현 (`console.log`)
- [x] `--diff` 플래그 시에만 비교 실행 (analyze.mjs에서 이미 구현)
- [x] `hasChanges === true`일 때만 `notify()` 호출 (analyze.mjs에서 이미 구현)
- [x] `output/diff.json` 생성

### 내장 Assert

snapshot 함수:
```javascript
export async function snapshot(report, snapshotsDir) {
  // 입력 검증
  assertHasKeys(report, ['timestamp', 'apis'], 'DIFF', 'snapshot 입력 report');

  const timestamp = report.timestamp.replace(/[:.]/g, '-');
  const snapshotPath = join(snapshotsDir, `snapshot-${timestamp}.json`);
  const latestPath = join(snapshotsDir, 'latest.json');

  await writeJson(snapshotPath, report);
  await writeJson(latestPath, report);

  // 저장 후 검증
  assertFileExists(snapshotPath, 'DIFF');
  assertFileExists(latestPath, 'DIFF');

  // 내용 무결성 (왕복 검증)
  const saved = await readJson(latestPath);
  assert(
    JSON.stringify(saved) === JSON.stringify(report),
    'DIFF', 'latest.json 내용이 원본과 불일치'
  );
}
```

diff 함수:
```javascript
export async function diff(currentReport, snapshotsDir) {
  const latestPath = join(snapshotsDir, 'latest.json');

  // 이전 스냅샷 없으면 첫 실행 — 비교 생략
  if (!existsSync(latestPath)) {
    log('DIFF', '이전 스냅샷 없음 — 첫 실행, 비교 생략');
    return { hasChanges: false, changes: [], firstRun: true };
  }

  const previousReport = await readJson(latestPath);
  assertHasKeys(previousReport, ['timestamp', 'apis'], 'DIFF', '이전 스냅샷');

  const changes = [];

  for (const [apiPath, currentApi] of Object.entries(currentReport.apis)) {
    const prevApi = previousReport.apis[apiPath];
    if (!prevApi) {
      changes.push({ type: 'api_added', api: apiPath });
      continue;
    }

    // 필드 diff
    const prevFields = new Set(prevApi.responseFields || []);
    const currFields = new Set(currentApi.responseFields || []);
    for (const f of currFields) if (!prevFields.has(f)) changes.push({ type: 'field_added', api: apiPath, field: f });
    for (const f of prevFields) if (!currFields.has(f)) changes.push({ type: 'field_removed', api: apiPath, field: f });

    // ENUM diff
    for (const [enumName, enumData] of Object.entries(currentApi.enums || {})) {
      const prevValues = new Set(prevApi.enums?.[enumName]?.foundValues || []);
      const currValues = new Set(enumData.foundValues || []);
      for (const v of currValues) if (!prevValues.has(v)) changes.push({ type: 'enum_added', api: apiPath, field: enumName, value: v });
      for (const v of prevValues) if (!currValues.has(v)) changes.push({ type: 'enum_removed', api: apiPath, field: enumName, value: v });
    }
  }

  const result = { timestamp: new Date().toISOString(), hasChanges: changes.length > 0, changes };

  // 결과 구조 검증
  assertType(result.hasChanges, 'boolean', 'DIFF', 'diff.hasChanges');
  assert(Array.isArray(result.changes), 'DIFF', 'diff.changes는 배열이어야 함');

  // hasChanges와 changes 일관성
  assert(
    result.hasChanges === (result.changes.length > 0),
    'DIFF', 'hasChanges와 changes.length 불일치',
    { hasChanges: result.hasChanges, changesLength: result.changes.length }
  );

  return result;
}
```

### 검증

- [ ] 첫 실행(스냅샷 없음) → `firstRun: true` 로그, assert 에러 없음
- [ ] 두 번째 실행(동일 데이터) → `hasChanges: false`, assert 에러 없음
- [ ] `latest.json` 수동 편집 후 실행 → 변경 감지 + notify 로그

---

## Phase 7: 문서화 + 마무리

**목표:** 사용 가능한 문서와 안정적인 에러 처리

- [x] `jungle-campus-analyzer/README.md` 작성
  - [x] 사전 요구사항: Node.js 22+, Chromium
  - [x] 설치: `npm install` → `npx playwright install chromium`
  - [x] 사용 예시: 로그인, 분석, diff, 필터
  - [x] 출력 디렉토리 구조 설명
  - [x] 알려진 이슈: prettier ESM 패치, 세션 만료
- [x] 모든 실패 경로에 명확한 에러 메시지 확인
- [x] `--verbose` 디버그 로그 동작 확인

### 검증 (End-to-End)

- [ ] `node analyze.mjs --url https://jungle-lms.krafton.com/check-in --verbose` → 모든 스테이지 assert 통과, exit code 0
- [ ] `node analyze.mjs --url https://jungle-lms.krafton.com/check-in --diff` → 스냅샷 비교 assert 통과
- [ ] `--verbose` 시 상세 로그 출력, 없을 때 미출력

---

## 핵심 파일 참조

| 파일 | 역할 |
|------|------|
| `analyze.mjs` | CLI 진입점, 파이프라인 오케스트레이션 |
| `lib/assert.mjs` | 공용 assert 헬퍼 (전 스테이지에서 사용) |
| `lib/collector.mjs` | Playwright 세션 관리 + 데이터 수집 (가장 복잡) |
| `lib/debundler.mjs` | webcrack 디번들링 |
| `lib/unminifier.mjs` | wakaru unminify |
| `lib/extractor.mjs` | ENUM 패턴 탐지 + report.json 생성 (핵심 분석) |
| `lib/differ.mjs` | 스냅샷 관리 + diff + 알림 |
| `lib/utils.mjs` | 공용 헬퍼 (ensureDir, log, JSON I/O) |
| `scripts/patch-prettier.mjs` | wakaru prettier 2.x ESM 워커라운드 |
