# Jungle Campus API 모델 추출기

Jungle Campus(jungle-lms.krafton.com) 프론트엔드의 JS 번들을 정적 분석하여 API 엔드포인트와 ENUM을 자동 추출하는 도구.

## 사전 요구사항

- **Node.js 22+**
- **Chromium** (Playwright가 자동 설치)

## 설치

```bash
cd jungle-campus-analyzer
npm install
npx playwright install chromium
```

> `npm install` 시 `postinstall` 훅이 prettier 2.x ESM 패치를 자동 적용합니다.

## 사용법

### 1. 최초 로그인 (1회)

```bash
node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in
```

브라우저가 열리면 구글 계정으로 로그인한 뒤 **브라우저를 닫아주세요**. 세션이 `.browser-data/`에 저장됩니다.

### 2. 분석 실행

```bash
node analyze.mjs --url https://jungle-lms.krafton.com/check-in
```

### 3. 특정 API만 필터링

```bash
node analyze.mjs --url https://jungle-lms.krafton.com/check-in --filter "/api/v2/me/cohorts,/attendance/today"
```

### 4. 상세 로그

```bash
node analyze.mjs --url https://jungle-lms.krafton.com/check-in --verbose
```

## CLI 옵션

| 옵션 | 설명 |
|------|------|
| `--url <url>` | **(필수)** 분석할 페이지 URL |
| `--login` | 수동 로그인 모드 |
| `--filter <apis>` | 쉼표 구분 API 경로 필터 |
| `--verbose` | 디버그 로그 출력 |
| `--help` | 도움말 |

## 출력 디렉토리 구조

```
output/
├── raw-bundles/            # 원본 JS 번들 파일
├── debundled/              # 디번들 결과 (Turbopack + webpack)
├── unminified/             # wakaru unminify 결과
└── api-modules/
    └── report.json         # API 모델 + ENUM 리포트
```

## 파이프라인

1. **데이터 수집** — Playwright로 JS 번들 파일 수집
2. **디번들링** — Turbopack(AST 파서) / webpack(webcrack)으로 개별 모듈 분리
3. **Unminify** — wakaru로 코드 가독성 복원
4. **패턴 분석** — `httpV2.*()` 정적 분석으로 API 엔드포인트 추출, 구조 기반 ENUM 자동 감지

## report.json 스키마

```json
{
  "timestamp": "2025-...",
  "apis": {
    "GET /api/v2/me/cohorts": {
      "method": "GET",
      "pathParams": null,
      "queryParams": null,
      "errorMessages": { "generic": "소속 기수 목록을 불러오는데 실패했어요." },
      "source": "22586.js:L7"
    }
  },
  "enums": {
    "attendance_status": ["ABSENT", "LATE", "PRESENT", "SELF_STUDY"],
    "leave_request_status": ["APPROVED", "PENDING", "REJECTED", "RETURNED"]
  },
  "relatedModules": ["22586.js", "850325.js", "617321.js", "320746.js"]
}
```

## 런타임 응답 캡처

현재는 정적 분석만 수행합니다. 실제 API 응답 JSON(필드명, 타입)이 필요하면 `collector.mjs`에서 Playwright `page.on('response')` 인터셉트로 `/api/v2/` 응답을 캡처하고, `extractor.mjs`에서 정적 분석 결과와 병합하는 방식으로 확장할 수 있습니다.

## 알려진 이슈

- **prettier ESM 패치**: wakaru가 의존하는 prettier 2.x가 ESM 환경에서 모듈 해석 오류를 발생시킴. `postinstall` 스크립트가 자동 패치하지만, `node_modules` 삭제 후 반드시 `npm install` 재실행 필요.
- **세션 만료**: 구글 로그인 세션이 만료되면 `--login`으로 재로그인 필요.
- **wakaru CJS**: `@wakaru/unminify`와 `@wakaru/unpacker`는 ESM 직접 import 불가. 내부적으로 `createRequire()` 워커라운드 사용.
