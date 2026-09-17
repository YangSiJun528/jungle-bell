# Chromium에서 에이전트가 웹 QA 수행하기

> 문서 유형: 방법 안내(how-to guide)

Playwright의 headless Chromium을 에이전트가 지속 세션에서 조작합니다. 현재 화면·접근성 트리를
읽고 다음 행동을 결정하며, `page.screenshot()`으로 받은 이미지를 직접 확인합니다. 사용자
Chrome 프로필이나 PC 커서를 사용하지 않습니다. 범위와 계정 처리는
[공통 QA 안내](guide-visual-qa.md), 릴리스 항목은 [QA 템플릿](template-release-qa.md)을 따릅니다.

## 준비

Node와 Playwright 라이브러리, 해당 버전의 Chromium이 필요합니다. 제공된 실행 환경의 패키지를
먼저 확인하고, 없으면 저장소 밖 도구 디렉터리에 Playwright와 Chromium을 설치합니다.
실제 실행 파일·패키지 경로와 버전은 [로컬 환경](reference-local-qa-environment.md)에 둡니다.
프로젝트의 제품 의존성에 QA용 패키지를 추가할 필요는 없습니다.
[Playwright 라이브러리](https://playwright.dev/docs/library) · [브라우저 설치](https://playwright.dev/docs/browsers)

`frontend/`에서 빈 포트로 개발 서버를 시작합니다. API origin·급식 이미지 origin·dev 모드
제약은 공통 안내와 같습니다. 로컬 listener나 Chromium의 macOS 프로세스 생성이 sandbox에서
거부되면 해당 실행 권한을 확보하며, 이를 브라우저 미설치로 판단하거나 전경 브라우저로 대체하지 않습니다.

```bash
mise exec -- npm run dev:web -- --host 127.0.0.1 --port "$qa_web_port" --strictPort
```

## 지속 세션 열기

이미 제공된 Node REPL을 사용하거나, `qa_node`와 `qa_playwright_module`에 실행 파일과
Playwright 패키지 디렉터리를 지정해 터미널 REPL을 엽니다. 서버와 REPL은 별도 세션에서 유지합니다.

```bash
QA_PLAYWRIGHT_MODULE="$qa_playwright_module" "$qa_node" --experimental-repl-await
```

아래는 터미널 Node REPL 예시입니다. `qaUrl`은 실행한 개발 서버 URL로 바꿉니다.
도구가 제공하는 REPL은 그 도구의 모듈 로딩·출력 API를 사용합니다.

```js
var { chromium } = require(process.env.QA_PLAYWRIGHT_MODULE);
var qaFs = require('node:fs/promises');
var qaPath = require('node:path');
var qaArtifacts = await qaFs.mkdtemp(qaPath.join(require('node:os').tmpdir(), 'jungle-bell-playwright-'));
var qaUrl = 'http://127.0.0.1:5175/#/home';
var qaBrowser = await chromium.launch({ headless: true, channel: 'chromium' });
var qaContext = await qaBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
var qaPage = await qaContext.newPage();
var qaErrors = [];
qaPage.on('pageerror', error => qaErrors.push(error.message));
await qaPage.goto(qaUrl);
console.log({ version: qaBrowser.version(), url: qaPage.url(), artifacts: qaArtifacts });
```

`channel: 'chromium'`은 설치한 Chromium의 새 headless 경로를 선택합니다. 실행된 엔진·버전을
결과에 기록합니다. 전체 테스트 순서를 한 스크립트에 고정하지 않고 다음 호출을 나누어 수행합니다.

## 관찰 → 조작 → 캡처

현재 화면의 요소와 이름을 읽습니다. 인증 입력값·쿠키·세션 원문은 출력하지 않습니다.

```js
console.log(await qaPage.locator('body').ariaSnapshot());
```

그 결과에서 선택한 요소를 `getByRole()` 등의 locator로 조작합니다. 다음은 현재 화면에서
확인한 버튼을 누르는 예시이며, 버튼 이름은 실제 관찰값을 사용합니다.

```js
await qaPage.getByRole('button', { name: '알림', exact: true }).click();
console.log(await qaPage.getByRole('dialog').ariaSnapshot());
```

전환이 끝나고 필요한 내용이 화면에 나타났는지 확인한 뒤 캡처합니다. DOM에 존재한다는 사실만으로
슬라이드 중인 패널이 보인다고 판정하지 않습니다. 고정 대기 시간보다 locator의 준비 상태와
현재 애니메이션·레이아웃 상태를 사용합니다. 가려진 요소를 `force`나 직접 DOM 클릭으로 우회하지 않습니다.

```js
await qaPage.screenshot({ path: qaPath.join(qaArtifacts, 'observed.png'), fullPage: true });
```

저장한 파일을 **에이전트의 이미지 도구로 열어 확인**합니다. Preview 창·Playwright Inspector·
headed 브라우저를 띄울 필요는 없습니다. 전체 페이지 캡처는 현재 viewport의 잘림과 다르므로,
고정 패널·하단 메뉴는 `fullPage: false` 캡처도 확인합니다.
[스크린샷 API](https://playwright.dev/docs/api/class-page#page-screenshot)

좁은 웹 화면은 다음처럼 확인할 수 있습니다. 이는 반응형 Chromium 웹 검증이며 Android·iOS
실제 브라우저, 설치 PWA, OS Push 검증을 대신하지 않습니다.

```js
await qaPage.setViewportSize({ width: 390, height: 844 });
console.log(await qaPage.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth })));
await qaPage.screenshot({ path: qaPath.join(qaArtifacts, 'narrow.png') });
```

## 종료

관찰 결과와 `qaErrors`를 함께 확인하고 이번 세션의 context·browser만 종료합니다.
개발 서버도 해당 터미널에서 종료합니다. 이미지·보고서는 임시 경로로 전달하며 저장소에 넣지 않습니다.

```js
console.log(qaErrors);
await qaContext.close();
await qaBrowser.close();
```
