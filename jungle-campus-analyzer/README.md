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

# 옵션: --filter <apis>       특정 API만 필터링
#        --verbose              상세 로그
#        --snapshot-root <dir>  스냅샷 저장 디렉터리 지정 (아래 참고)
```

## 스냅샷 & 변경 추적

`--snapshot-root` 옵션을 지정하면 실행 결과를 파일로 저장하고 이전 결과와 비교합니다.

```bash
# 저장소 루트 기준으로 실행
node analyze.mjs --url https://jungle-lms.krafton.com/check-in --snapshot-root ../campus/webcrack
```

**저장 구조:**

```
campus/webcrack/
  logs/      ← 매 실행 결과 전체 저장 (gitignore, 로컬 참조용)
               파일명: YYYY-MM-DDTHH-MM-SS.json
  changes/   ← 변경 있을 때만 저장 (git 추적)
               파일명: YYYY-MM-DDTHH-MM-SS.json
```

- `logs/`: 실행할 때마다 `report.json` 스냅샷이 쌓임. git에 포함되지 않음.
- `changes/`: 이전 로그와 diff 했을 때 변경이 감지된 경우에만 생성. 자동 커밋 대상.

**스킬로 실행** (Claude Code):

```
/webcrack-snapshot                                          # 기본 URL 사용
/webcrack-snapshot https://jungle-lms.krafton.com/check-in # 명시적 URL
```

파이프라인 실행 → 스냅샷 저장 → 변경 감지 시 아래 형식으로 자동 커밋:

```
[webcrack] 2026-04-01: 3건 변경 (api_added, enum_removed)
```

변경 커밋 히스토리 확인:

```bash
git log --oneline | grep '\[webcrack\]'
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
