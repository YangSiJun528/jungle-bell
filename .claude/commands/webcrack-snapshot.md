---
description: "jungle-lms.krafton.com JS 번들을 역디번들링하여 API 스냅샷을 저장하고, 변경이 감지되면 git 자동 커밋합니다. 사용자가 API 스키마 추출, 번들 분석, webcrack 스냅샷 실행을 요청할 때 사용합니다."
allowed-tools: Bash, Read, Grep, AskUserQuestion
---

## URL

`$ARGUMENTS`에 `https://`로 시작하는 URL이 있으면 사용, 없으면 기본값 사용:

```
https://jungle-lms.krafton.com/check-in
```

## 실행 (백그라운드)

명령을 백그라운드로 실행 (`run_in_background: true`):

```bash
cd jungle-campus-analyzer && node analyze.mjs --url <URL> --snapshot-root ../campus/webcrack 2>&1
```

## 완료 대기 절차

백그라운드 실행 후 task notification이 올 때까지 아래 순서로 대기:

1. **7분 대기** (`sleep 420`) 후 완료 여부 확인
2. 미완료 시 **1분 대기** × 최대 5회 반복 (총 최대 12분)
3. 12분 후에도 미완료 시 AskUserQuestion으로 질문:
   ```
   아직 실행 중입니다. 계속 기다릴까요, 아니면 중단할까요?
   (계속/중단)
   ```
   - 계속: 1분 대기 후 다시 확인, 미완료 시 재질문
   - 중단: 작업 중단 안내 후 종료

완료 확인은 task notification 수신 여부로 판단.

## 결과 처리

| 출력 | 처리 |
|------|------|
| `세션 만료` 또는 `--login` 포함 | 재로그인 안내 출력 |
| 그 외 에러 (exit 1) | 에러 내용 그대로 보고 |
| `[SNAPSHOT] 변경 있음: N건 → <경로>` | 커밋 진행 |
| `[SNAPSHOT] 변경 없음` 또는 `첫 실행` | 커밋 없이 완료 보고 |

**재로그인 필요 시 안내:**
```
세션이 만료되었습니다. 재로그인 후 다시 실행하세요:
  cd jungle-campus-analyzer && node analyze.mjs --login --url https://jungle-lms.krafton.com/check-in
브라우저가 열리면 구글 로그인 후 창을 닫으세요.
```

## 커밋 (변경 있을 때만)

`[SNAPSHOT]` 라인의 changes 파일만 스테이징 후 커밋. 제목 규칙:

```
[webcrack] YYYY-MM-DD: N건 변경 (type1, type2)
```

변경 타입은 changes 파일의 `changes[].type` 값, 날짜는 오늘 날짜.
