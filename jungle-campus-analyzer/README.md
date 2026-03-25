# Jungle Campus API 모델 추출기

Jungle Campus(jungle-lms.krafton.com) 프론트엔드 JS 번들을 정적 분석하여 API 엔드포인트와 ENUM을 자동 추출.

## 설치

```bash
cd jungle-campus-analyzer
npm install                      # postinstall이 prettier ESM 패치 자동 적용
npx playwright install chromium
```

## 사용법

```bash
# 최초 로그인 (1회) — 브라우저에서 구글 로그인 후 닫기
node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in

# 분석 실행
node analyze.mjs --url https://jungle-lms.krafton.com/check-in

# 옵션: --filter <apis>  특정 API만 필터링
#        --verbose        상세 로그
```

## 파이프라인

1. **수집** — Playwright로 JS 번들 수집 (인증 세션 필요)
2. **디번들링** — Turbopack(AST) / webpack(webcrack) → 개별 모듈 분리
3. **Unminify** — wakaru로 가독성 복원
4. **추출** — `httpV2.*()` 패턴으로 API 엔드포인트 + ENUM 자동 감지

결과: `output/api-modules/report.json`

## report.json 예시

```json
{
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
  }
}
```

## 참고

- **런타임 응답 캡처**: 현재는 정적 분석만 수행. API 응답 JSON이 필요하면 `collector.mjs`에서 `page.on('response')`로 `/api/v2/` 응답을 캡처하는 방식으로 확장 가능.
- **Unminify 경고**: `prettier Invalid left-hand side`, `lebab markModified` 등은 React 내부 코드 복원 실패로 발생하며, API 모듈에는 영향 없음. 무시 가능.
- **세션 만료**: `--login`으로 재로그인.
- **prettier ESM 패치**: `node_modules` 삭제 후 반드시 `npm install` 재실행.
