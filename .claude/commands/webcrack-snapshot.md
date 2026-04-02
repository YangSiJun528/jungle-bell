---
description: "역디번들링 파이프라인 실행 후 스냅샷 저장 및 변경 시 자동 커밋"
allowed-tools: Bash, Read, Grep, AskUserQuestion
---

Jungle Campus Analyzer 전체 파이프라인을 실행하고 결과를 스냅샷으로 저장합니다.
변경이 감지되면 `campus/webcrack/changes/` 파일을 자동 커밋합니다.

**URL 결정**: `$ARGUMENTS`에서 URL을 추출합니다.
- `$ARGUMENTS`가 비어 있거나 `https://`로 시작하는 URL이 없으면 기본값 `https://jungle-lms.krafton.com/check-in` 을 사용합니다.
- 별도 URL을 물어보지 않습니다.

**실행 순서**:

1. 파이프라인 실행 (작업 디렉터리: 저장소 루트):
   ```bash
   cd jungle-campus-analyzer && node analyze.mjs --url <URL> --snapshot-root ../campus/webcrack
   ```

2. 출력에서 `[SNAPSHOT]` 라인 확인:
   - `[SNAPSHOT] 변경 있음: N건 → <파일경로>` 패턴이 있으면 → **3단계 진행**
   - `[SNAPSHOT] 변경 없음` → 커밋 없이 완료 메시지 출력
   - `[SNAPSHOT] 첫 실행` → 커밋 없이 완료 메시지 출력
   - 파이프라인 에러(exit code 1) → 에러 내용 그대로 사용자에게 보고

3. 변경 있을 때만 커밋:
   - 변경 건수(N)와 변경 파일 경로를 `[SNAPSHOT]` 라인에서 추출
   - `git add <파일경로>` (changes/ 파일만, logs/ 제외)
   - 변경 타입 목록을 파일에서 읽어 정리 (예: `api_added`, `enum_removed`)
   - 커밋 메시지 형식 (grep 용이):
     ```
     [webcrack] YYYY-MM-DD: N건 변경 (type1, type2, ...)
     ```
     날짜는 파일명에서 추출하거나 `date +%Y-%m-%d` 로 가져옵니다.
   - 커밋은 HEREDOC 형식으로:
     ```bash
     git commit -m "$(cat <<'EOF'
     [webcrack] 2026-04-01: 3건 변경 (api_added, enum_removed)

     Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
     EOF
     )"
     ```

**완료 후**: 커밋 여부, 저장된 파일 경로, 변경 내용 요약을 사용자에게 출력합니다.
