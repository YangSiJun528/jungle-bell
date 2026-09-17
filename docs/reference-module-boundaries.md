# 모듈 의존성 규칙

> 문서 유형: 참조(reference)

프론트엔드 의존성은 dependency-cruiser와 Oxlint, 서버 의존성은 Gradle 모듈과
ArchUnit 테스트로 검사한다. 아래 표는 저장소 내부 소스 간 허용 의존성을 나타낸다.

## 검증 명령

| 실행 위치 | 명령 | 검사 대상 |
| --- | --- | --- |
| `frontend/` | `npm run architecture` | 전체 `src`의 문법 제약과 의존성 그래프 |
| `frontend/` | `npm run test:architecture` | 정상·위반 fixture로 검사 명령의 동작 검증 |
| `frontend/` | `npm run check` | 포맷, lint, 아키텍처, 타입, 테스트 |
| `frontend/` | `npm run verify:web` | 포맷, lint, 아키텍처, 웹 빌드, 테스트 |
| `server/` | `./gradlew test` | 세 모듈의 아키텍처 검사와 단위 테스트(Docker 불필요) |

서버 아키텍처 검사만 실행하는 명령은 다음과 같다. 각 모듈의 `main` 클래스 경로를
Gradle이 전달하므로 Gradle을 통해 실행해야 한다.

```bash
./gradlew :core:test --tests '*Architecture*' :api:test --tests '*Architecture*' :worker:test --tests '*Architecture*'
```

## 프론트엔드 허용 의존성

기준 설정은 [`.dependency-cruiser.cjs`](../frontend/.dependency-cruiser.cjs)다.
표의 경로는 `frontend/src/` 기준이며, `platform 공통`은 `platform/` 바로 아래의
`.ts` 파일을 뜻한다. `components/ui`를 제외한 공유 컴포넌트는 `components` 행을 따른다.

| 소스 | 허용 대상 |
| --- | --- |
| `lib` | `lib` |
| `domain` | `domain`, `lib` |
| `navigation` | `navigation`, `domain`, `lib` |
| `api` | `api`, `domain`, `lib`, platform 공통 |
| `state` | `state`, `api`, `domain`, `navigation`, `lib`, platform 공통 |
| `hooks` | `hooks`, `lib`, platform 공통 |
| `components/ui` | `components/ui`, `hooks`, `lib` |
| `components` | `components`, `hooks`, `state`, `navigation`, `api`, `domain`, `lib`, `assets`, platform 공통 |
| `features/<기능>` | 같은 기능, `components`, `hooks`, `state`, `navigation`, `api`, `domain`, `lib`, `assets`, platform 공통 |
| `app` | `app`, `features`, `components`, `hooks`, `state`, `navigation`, `api`, `domain`, `lib`, `assets`, platform 공통 |
| platform 공통 | platform 공통, `api`, `domain`, `lib` |
| `platform/web`, `platform/pwa`, `platform/tauri`의 구현 (`entry.ts` 제외) | 같은 플랫폼 구현, platform 공통, `domain`, `lib` |

- 기능 간 직접 import는 금지한다. 여러 기능을 묶는 코드는 `app`에, 재사용하는
  상태와 UI는 `state`와 `components`에 둔다.
- `state/`는 계정·대시보드 상태와 query를, `navigation/routes.ts`는 공통 경로를
  소유한다. 계정 접근 UI는 `components/account/`, PWA 설치 UI는
  `components/pwa/`에 둔다. 이 코드에서 `app`을 역참조하지 않는다.
- 플랫폼 구현끼리 직접 참조할 수 없다. `@tauri-apps/*`는 `platform/tauri/`만
  사용할 수 있다.
- `platform/web/entry.ts`와 `platform/tauri/entry.ts`는 플랫폼 어댑터와 공통
  bootstrap을 구성하는 진입점이다. `main.ts`와 두 진입점은 조립 지점으로서 위의
  계층 허용 목록에서 제외한다. 두 진입점을 import하는 운영 코드는 `main.ts`뿐이다.
- `app`은 PWA 업데이트 연결을 위해 `platform/pwa/update-bootstrap.ts`와
  `platform/pwa/update-lifecycle.ts`를 참조할 수 있다.
- 운영 코드의 순환 참조, 테스트 코드 참조, 해석할 수 없는 import는 오류다.
  `*.test.*`와 `src/tests/`는 계층·플랫폼 격리 규칙에서 제외하지만 전체 스캔과
  import 해석 검사는 받는다.

### 검사 범위와 문법 제약

실행기는 [`check-architecture.mjs`](../frontend/scripts/check-architecture.mjs)다.
TypeScript 7의 컴파일러 API를 dependency-cruiser 18이 지원하지 않아 SWC로
TS/TSX를 분석한다. `tsconfig.json`의 `paths`를 resolver에 전달하므로 `@/` 별칭과
상대 경로에 같은 규칙을 적용한다. 재수출, 문자열 리터럴을 사용하는 동적 import,
타입 import도 검사한다.

SWC가 안정적으로 추출하지 못하는 타입 표현식 `import('...').Type`,
`typeof import('...')`, 로컬 파일을 가리키는 `/// <reference path="..." />`는
[`.oxlint-architecture.json`](../frontend/.oxlint-architecture.json)에서 금지한다.
명시적인 `import type` 선언은 허용하며 그 의존 관계도 검사한다.
triple-slash의 `types`와 `lib` 참조는 허용한다. 이 문법 검사는 그래프 분석 전에 실행하며,
일반 lint도 같은 설정을 상속한다.

실행기는 `src`의 `ts`, `tsx`, `js`, `jsx`, `mts`, `cts`, `mjs`, `cjs` 파일 목록과
그래프에 포함된 파일 목록을 비교한다.
파일이 누락되거나, 파서 환경 문제가 있거나, 검사할 소스가 없으면 실패한다.
[`test-architecture.mjs`](../frontend/scripts/test-architecture.mjs)는 허용된 참조가
통과하고 의도적인 위반이 실패하는지 실제 검사 명령으로 검증한다.

## 서버 허용 의존성

기준 규칙은
[`ServerArchitectureRules.kt`](../server/core/src/testFixtures/kotlin/app/junglebell/architecture/ServerArchitectureRules.kt)다.
Gradle 프로젝트 의존성은 `api → core ← worker`이며, 각 모듈의 `main` 출력만
ArchUnit으로 읽는다. 다른 모듈의 패키지를 자신의 소스에 선언해도 실패한다.

| Gradle 모듈 | 소유 패키지 (`app.junglebell.server` 아래) | 허용하는 서버 의존성 |
| --- | --- | --- |
| `core` | `common`, `domain` | `common`, `domain` |
| `api` | `api` | `api`, `common`, `domain` |
| `worker` | `worker` | `worker`, `common`, `domain` |

`common → domain`은 금지한다. `domain/<기능>`은 같은 기능과 `common`을 사용할 수
있으며, 다른 기능은 아래 목록만 허용한다.

| 기능 | 허용하는 다른 기능 |
| --- | --- |
| `account` | `security` |
| `automation` | `notification`, `publicapi` |
| `notification` | `security` |
| `pairing` | `security` |
| `personal` | `security` |
| `publicapi` | 없음 |
| `security` | 없음 |
| `usage` | `security` |

- 기능 간 순환 참조는 금지한다. 새 기능 패키지는 규칙의 허용 목록에 등록해야 한다.
- 운영 코드는 `Jdbc*Store` 구체 타입을 직접 참조하지 않고 `*Store` port를 사용한다.
  해당 구현 자신과 중첩 클래스의 내부 참조는 허용한다.
- Spring·HTTP·JDBC 의존성은 현재 core 설계에 포함된다. 이 검사는 core에서 외부
  라이브러리를 일괄 금지하지 않는다.
- 테스트 코드는 운영 클래스 검사에서 제외한다. 저장소 통합 테스트는 JDBC 구현을
  직접 생성할 수 있다. 별도 fixture 테스트는 금지 의존성과 순환이 검출되는지 확인한다.
- ArchUnit과 공유 규칙은 테스트 의존성이며 API·Worker 실행 JAR에는 포함하지 않는다.
