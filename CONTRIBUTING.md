# Jungle Bell에 기여하기

> 문서 유형: 방법 안내(how-to guide)

이 문서는 Jungle Bell을 로컬에서 실행하고 변경 사항을 검증하는 절차를 설명합니다.

## 준비

- Node.js 24
- Java 21
- Rust stable과 `rustfmt`, `clippy`
- prek 0.4.9 이상
- 서버를 로컬에서 실행할 경우 Docker
- Tauri가 요구하는 운영체제별 빌드 도구

## Git 훅 설치

저장소 루트에서 prek의 `pre-commit`, `pre-push` 훅을 설치합니다.

```bash
prek install
```

`pre-commit`은 staged diff, 설정 파일, 프론트엔드 포맷·lint와 Rust 포맷을 빠르게 검사합니다. `main` 브랜치에는 직접 커밋할 수 없습니다. `pre-push`는 변경 경로에 따라 프론트엔드 check, 서버 Gradle check, 데스크톱 test·clippy를 실행합니다.

설정과 기본 위생 검사를 수동으로 확인하려면 다음 명령을 실행합니다.

```bash
prek validate-config prek.toml
prek run --all-files --group hygiene
```

모든 `pre-push` 검사를 수동으로 실행하려면 다음 명령을 사용합니다.

```bash
prek run --all-files --stage pre-push
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
npm ci
```

### 웹·PWA

```bash
npm run dev:web
```

### PC 앱

macOS와 Linux에서는 다음과 같이 실행합니다.

```bash
export JUNGLE_BELL_DATA_API_URL=https://jungle-bell.sijun-yang.com
npm run desktop:dev
```

Windows PowerShell에서는 환경 변수를 먼저 설정합니다.

```powershell
$env:JUNGLE_BELL_DATA_API_URL = "https://jungle-bell.sijun-yang.com"
npm run desktop:dev
```

### 서버

서버 모듈을 빌드하고 테스트합니다.

```bash
cd server
./gradlew check :api:bootJar :worker:bootJar
```

PostgreSQL을 포함한 로컬 실행 방법은 [`server/README.md`](server/README.md)를 참고하세요.

## 변경 사항 검증

프론트엔드와 PC 앱 전체 검증은 위와 같은 방식으로 `JUNGLE_BELL_DATA_API_URL`을 설정한 뒤 실행합니다.

```bash
cd frontend
npm run verify
```

서버 전체 검증:

```bash
cd server
./gradlew --no-daemon check :api:bootJar :worker:bootJar
```

문서만 변경했더라도 링크, 이미지 경로와 Markdown 렌더링을 확인하고 `git diff --check`를 실행합니다.

## CI와 릴리스 경계

Pull Request와 `main` push에서는 GitHub Actions의 `CI` 워크플로가 hygiene, 웹, 서버,
macOS·Windows 데스크톱 검증을 실행합니다. 브랜치 규칙에는 고정 집계 잡인
`CI / required`를 필수 체크로 사용합니다.

서버 배포는 GitHub Actions에서 수행하지 않습니다. 운영망 접근 권한이 있는 로컬 환경에서
[OCI 운영 서버 배포 가이드](server/deploy/guide_oci_production_deployment.md)를 따라 수동으로
배포합니다.

데스크톱 릴리스는 `main`에서 `Desktop Release` 워크플로를 수동 실행합니다. 릴리스 태그가
가리키는 정확한 SHA의 `CI / required` 성공과 버전 일치를 확인한 뒤 초안 릴리스에 서명
산출물을 올리고, `desktop-release` 환경 승인을 거쳐 공개합니다.

## 기술 문서

- [플랫폼 아키텍처](docs/explanation-platform-architecture.md)
- [플랫폼 계약](docs/reference-platform-contract.md)
- [상태 관리](docs/state-management-reference.md)
- [UI 구조](docs/ui-layout-reference.md)
- [서버 API](server/docs/api-reference.md)

## Pull Request 전 확인

- `prek install`로 로컬 Git 훅을 설치합니다.
- 변경 범위에 해당하는 테스트와 검증 명령을 통과시킵니다.
- 사용자 동작이나 플랫폼 계약이 바뀌면 관련 문서를 함께 수정합니다.
- 비밀값, 개인 세션 파일, 로그와 캡처용 임시 파일을 커밋하지 않습니다.
- 관계없는 포맷 변경이나 생성물을 포함하지 않습니다.
