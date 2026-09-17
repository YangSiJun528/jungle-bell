# Jungle Bell에 기여하기

> 문서 유형: 방법 안내(how-to guide)

이 문서는 Jungle Bell을 로컬에서 실행하고 변경 사항을 검증하는 절차를 설명합니다.

## 준비

- mise 2025.8.11 이상
- 서버 실행 또는 PostgreSQL 통합 테스트를 실행할 경우 Docker
- Tauri가 요구하는 운영체제별 빌드 도구

Node.js 24, Temurin Java 21, Rust stable과 `rustfmt`·`clippy`, prek 0.4.14는
저장소의 `mise.toml`에서 관리합니다. 저장소 루트에서 설치합니다.

```bash
mise install
```

## Git 훅 설치

저장소 루트에서 prek의 `pre-commit`, `pre-push` 훅을 설치합니다.

```bash
mise exec -- prek install
```

`pre-commit`은 staged diff, 설정 파일, 프론트엔드 포맷·lint와 Rust 포맷을 빠르게 검사합니다. `main` 브랜치에는 직접 커밋할 수 없습니다. `pre-push`는 변경 경로에 따라 프론트엔드 check, 서버 Gradle test, 데스크톱 test·clippy를 실행합니다.
서버 경량 검증은 Docker가 필요 없는 단위·아키텍처 테스트만 실행합니다.
Docker가 필수인 통합 테스트는 CI의 `check` 또는 명시적인 `integrationTest`로 실행합니다.

설정과 기본 위생 검사를 수동으로 확인하려면 다음 명령을 실행합니다.

```bash
mise exec -- prek validate-config prek.toml
mise exec -- prek run --all-files --group hygiene
```

모든 `pre-push` 검사를 수동으로 실행하려면 다음 명령을 사용합니다.

```bash
mise exec -- prek run --all-files --stage pre-push
```

## 저장소 구조

| 경로 | 역할 |
| --- | --- |
| `frontend/` | 공통 Vite·React SPA와 Web·PWA·Tauri 어댑터 |
| `desktop/` | Tauri Rust 런타임, capability와 번들 설정 |
| `server/` | Spring Core·API·Worker 멀티모듈 |
| `docs/` | 플랫폼 구조, 상태 관리와 UI 계약 문서 |

웹과 PC 앱은 같은 React 화면을 사용합니다. 웹 빌드는 `frontend/dist/web`, Tauri UI 빌드는 `frontend/dist/desktop`에 생성됩니다.

## 로컬 실행

먼저 프론트엔드 의존성을 설치합니다.

```bash
cd frontend
mise exec -- npm ci
```

### 웹·PWA

```bash
mise exec -- npm run dev:web
```

### PC 앱

macOS와 Linux에서는 다음과 같이 실행합니다.

```bash
export JUNGLE_BELL_DATA_API_URL=https://jungle-bell.sijun-yang.com
mise exec -- npm run desktop:dev
```

Windows PowerShell에서는 환경 변수를 먼저 설정합니다.

```powershell
$env:JUNGLE_BELL_DATA_API_URL = "https://jungle-bell.sijun-yang.com"
mise exec -- npm run desktop:dev
```

QA 중 대시보드가 포커스를 가져오지 않게 하려면 실행 환경에
`JUNGLE_BELL_WINDOW_FOCUS=false`를 지정합니다. 새 창은 포커스 없이 표시하고,
기존 창에는 표시·최소화 해제·포커스를 요청하지 않습니다. 따라서 숨기거나 최소화한
창은 복원하지 않습니다. 허용값은 소문자 `true`와 `false`이며, 미설정이나 잘못된
값은 기존 `true` 동작을 유지합니다.
`false`일 때 macOS의 앱 활성화 정책·Dock 표시 변경도 생략하지만, LMS 로그인 창의
직접 포커스 요청과 운영체제 대화상자에는 적용하지 않습니다.

### 서버

서버 모듈을 빌드하고 테스트합니다.

```bash
cd server
mise exec -- ./gradlew check :api:bootJar :worker:bootJar
```

PostgreSQL을 포함한 로컬 실행 방법은 [`server/README.md`](server/README.md)를 참고하세요.

## 변경 사항 검증

일반 작업의 QA는 최소 스모크(실행·주요 화면 진입·대표 동작)와 변경한 기능 및 직접 영향을
받는 기능만 확인합니다. 문서만 바뀌면 문서 검사로 충분합니다. 화면·기기별 실행 방법은
[Visual QA 안내](docs/guide-visual-qa.md)를 참고합니다.

프론트엔드 의존성 경계와 검사기 자체를 검증하려면 다음 명령을 실행합니다.
허용 의존성과 예외는 [모듈 의존성 규칙](docs/reference-module-boundaries.md)에 정의합니다.

```bash
cd frontend
mise exec -- npm run architecture
mise exec -- npm run test:architecture
```

프론트엔드와 PC 앱 전체 검증은 위와 같은 방식으로 `JUNGLE_BELL_DATA_API_URL`을 설정한 뒤 실행합니다.

```bash
cd frontend
mise exec -- npm run verify
```

서버는 Gradle 작업으로 테스트 범위를 선택합니다. `test`는 단위·아키텍처 테스트,
`integrationTest`는 Docker가 필요한 PostgreSQL 통합 테스트를 실행합니다.
`check`는 둘 다 실행하며, Docker에 연결할 수 없으면 통합 테스트는 실패합니다.

```bash
cd server
mise exec -- ./gradlew test
mise exec -- ./gradlew integrationTest
```

서버 전체 검증과 JAR 빌드:

```bash
cd server
mise exec -- ./gradlew --no-daemon check :api:bootJar :worker:bootJar
```

문서만 변경했더라도 링크, 이미지 경로와 Markdown 렌더링을 확인하고 `git diff --check`를 실행합니다.

## CI와 릴리스 경계

Pull Request와 `main` push에서는 GitHub Actions의 `CI` 워크플로가 hygiene, 웹, 서버,
macOS·Windows 데스크톱 검증을 실행합니다. 브랜치 규칙에는 고정 집계 잡인
`CI / required`를 필수 체크로 사용합니다. 각 잡은 `mise.toml`에서 필요한 도구만 설치해
로컬과 같은 버전 정책을 사용합니다.

Markdown(`.md`)만 변경한 PR은 `ci:docs-only` 라벨을 붙여 웹·서버·데스크톱 검증을
생략할 수 있습니다. CI는 PR 전체 변경 파일을 확인하고, 기본 위생 검사와 CI 범위 판정
테스트를 통과하면 `required`를 성공으로 처리합니다. 실행 요약에는 생략한 검증을 표시합니다.
코드·설정·이미지 등 `.md` 이외의 파일이 섞이거나 라벨이 없으면 전체 검증을 실행합니다.
라벨 추가·제거와 PR 변경 시 다시 판정하며, `main` push와 수동 실행은 항상 전체 검증합니다.
`[skip ci]`는 필수 `required` 검사까지 생략해 병합을 막으므로 사용하지 않습니다.

서버 배포는 GitHub Actions에서 수행하지 않습니다. 운영망 접근 권한이 있는 로컬 환경에서
[OCI 운영 서버 배포 가이드](server/deploy/guide_oci_production_deployment.md)를 따라 수동으로
배포합니다.

데스크톱 릴리스는 `main`에서 `Desktop Release` 워크플로를 수동 실행합니다. 릴리스 태그가
가리키는 정확한 SHA의 `CI / required` 성공과 버전 일치를 확인한 뒤 초안 릴리스에 서명
산출물을 올리고, `desktop-release` 환경 승인을 거쳐 공개합니다.

릴리스 요청을 받은 에이전트는 초안과 빌드를 준비한 뒤 해당 Actions 실행 링크를 제공합니다.
공개 승인은 GitHub의 `desktop-release` 환경에서만 받으며 대화에서 중복 확인하지 않습니다.

매 릴리스 공개 전에는 [전체 기능 QA 템플릿](docs/template-release-qa.md)의 사본을 저장소 밖에
만들어 수행합니다. 공통 로직은 해당 후보 SHA의 코드 검사 결과를 활용하고, 설치·로그인·트레이·
실제 알림처럼 환경에 의존하는 동작은 해당 환경에서 확인합니다. 실패·미실행 범위를 함께 전달하며,
실행 보고서와 캡처는 코드베이스에 보관하지 않습니다.

## 기술 문서

- [Codex 내장 에이전트 하네스](docs/guide-codex-harness.md)
- [플랫폼 아키텍처](docs/explanation-platform-architecture.md)
- [플랫폼 계약](docs/reference-platform-contract.md)
- [상태 관리](docs/state-management-reference.md)
- [UI 구조](docs/ui-layout-reference.md)
- [서버 API](server/docs/api-reference.md)

## Pull Request 전 확인

- `mise exec -- prek install`로 로컬 Git 훅을 설치합니다.
- 변경 범위에 해당하는 테스트와 검증 명령을 통과시킵니다.
- 사용자 동작이나 플랫폼 계약이 바뀌면 관련 문서를 함께 수정합니다.
- 기능을 추가·변경·삭제하면 릴리스 QA 템플릿의 해당 항목도 갱신합니다.
- 비밀값, 개인 세션 파일, 로그와 캡처용 임시 파일을 커밋하지 않습니다.
- 관계없는 포맷 변경이나 생성물을 포함하지 않습니다.
