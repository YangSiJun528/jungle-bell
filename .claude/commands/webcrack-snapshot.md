---
description: "jungle-lms.krafton.com JS 번들을 역디번들링하여 API 스냅샷을 저장하고, 변경이 감지되면 git 자동 커밋합니다. 사용자가 API 스키마 추출, 번들 분석, webcrack 스냅샷 실행을 요청할 때 사용합니다."
allowed-tools: Bash, Read, Grep
---

## URL

`$ARGUMENTS`에 `https://`로 시작하는 URL이 있으면 사용, 없으면 기본값 사용:

```
https://jungle-lms.krafton.com/check-in
```

## 실행

```bash
cd jungle-campus-analyzer && node analyze.mjs --url <URL> --snapshot-root ../campus/webcrack
```

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

`[SNAPSHOT]` 라인에서 파일 경로·변경 건수 추출, changes 파일의 `changes[].type` 필드로 타입 목록 확인:

```bash
git add <changes-파일경로>
git commit -m "$(cat <<'EOF'
[webcrack] YYYY-MM-DD: N건 변경 (type1, type2)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

날짜는 `date +%Y-%m-%d`로 가져옵니다.
