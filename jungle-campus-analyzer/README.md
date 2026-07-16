# Jungle Campus API 변경 관찰하기

이 도구는 테스트를 통과시키는 용도가 아니다. Jungle Campus 프론트엔드와 실제 GET 응답을 관찰해 다음 변경 후보를 만들고, 사람이 직접 의미를 확인하는 용도다.

- API 경로, 메서드, 요청 필드
- 정적 클라이언트 오류 조건과 사용자 메시지
- 실제로 관찰한 응답 필드·타입·ENUM 후보
- 익명화한 오류 응답 코드·메시지
- Jungle Bell이 의존하는 응답 필드의 변경 영향

기본 실행은 API 원본 값과 JS 번들을 저장하지 않는다. 보고서에는 응답의 구조만 남는다.

## 준비

Node.js 24.12 이상이 필요하다.

```bash
cd jungle-campus-analyzer
npm install
npx playwright install chromium
```

최초 한 번 로그인 세션을 저장한다.

```bash
npm run login
```

열린 브라우저에서 로그인한 뒤 창을 닫는다. 세션은 `.browser-data/`에 로컬로만 저장되고 Git에서 제외된다.

## 변경 관찰 실행

저장소 루트의 `campus/api-observer`에 검토 이력을 남기려면 다음처럼 실행한다.

```bash
npm run analyze -- --snapshot-root ../campus/api-observer
```

한 번의 실행은 다음 순서로 진행된다.

1. Playwright가 설정된 페이지를 방문해 그 실행에서 받은 번들과 API 응답만 수집한다.
2. Oxc가 압축된 번들을 직접 파싱해 HTTP 호출, ENUM 후보, 클라이언트 오류 처리를 찾는다.
3. 실제 응답 값은 저장하지 않고 JSON 필드·타입·필수 여부·상태 코드만 추론한다.
4. 이전 스냅샷과 의미 기반으로 비교한다.

결과 파일은 다음 위치에 생긴다.

```text
jungle-campus-analyzer/output/report.json   현재 결과
campus/api-observer/logs/                    매 실행 기준 스냅샷, Git 제외
campus/api-observer/changes/                 변경이 있을 때만 생성되는 검토 파일
```

첫 실행은 기준만 저장하고 `changes/` 파일을 만들지 않는다.

## 결과 검토

먼저 `changes/*.json`의 `changes`를 확인한다.

- `response_field_removed`, `response_type_changed`: 응답 필드 계약 후보
- `enum_value_added`, `enum_value_removed`: ENUM 후보
- `client_*`: 프론트엔드가 처리하는 오류 조건·메시지 후보
- `observed_error_*`: 실제 오류 응답에서 관찰한 코드·익명화 메시지 후보
- `appImpact: true`: Jungle Bell이 쓰는 필드와 겹치는 변경

그 다음 `output/report.json`에서 해당 엔드포인트의 근거를 확인한다.

- `sources`: `static`, `runtime`, `app-dependency` 중 어떤 근거인지 표시한다.
- `responses`: 상태 코드별 응답 스키마 목록이다.
- `errors`: 번들에서 찾은 클라이언트 오류 처리다.
- `observedErrors`: 실제 응답에서 찾은 오류 코드와 익명화 메시지다.
- `enums[].evidence`: 후보를 찾은 번들 위치 또는 런타임 엔드포인트다.

런타임 결과는 방문한 화면과 당시 데이터에 한정된다. `미관찰`은 삭제가 확정됐다는 뜻이 아니므로 직접 확인해야 한다.

## Jungle Bell 의존 필드 관리

[`observer.config.json`](./observer.config.json)의 `appDependencies`에 앱이 실제 사용하는 필드를 적는다.

```json
{
  "appDependencies": {
    "GET /api/v2/me/cohorts": ["id", "isActive", "startDate", "endDate"],
    "GET /api/v2/me/cohorts/{cohortId}/attendance/today": ["checkedAt", "checkedOutAt"]
  }
}
```

페이지 로드 중 호출되지 않은, 경로 변수가 없는 GET 의존 API는 같은 로그인 세션으로 추가 관찰한다. POST·PATCH·DELETE 요청은 자동 실행하지 않는다.

다른 화면에서만 호출되는 API까지 관찰하려면 설정의 `routes`에 경로를 추가하거나 실행할 때 반복해서 지정한다.

```bash
npm run analyze -- --route /learning --route /leave
```

## 진단과 검증

현재 실행의 번들만 별도로 보관해야 할 때만 `--artifacts`를 사용한다.

```bash
npm run analyze -- --artifacts /tmp/jungle-campus-bundles
```

이미 받은 번들의 정적 추출만 확인할 수도 있다. 이 모드에는 실제 응답 스키마가 없다.

```bash
npm run analyze -- --bundle-dir /path/to/bundles
```

코드 검증은 다음 명령으로 실행한다.

```bash
npm run verify
```

세션이 만료되면 `npm run login`을 다시 실행한다. 현재 번들에서 API를 하나도 찾지 못하면 오래된 결과를 재사용하지 않고 오류로 종료한다.
