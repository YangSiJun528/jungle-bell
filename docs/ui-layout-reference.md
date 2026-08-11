# UI 구조 참고 자료

> 문서 유형: 참조(reference)
>
> 확인일: 2026-08-11
>
> 대상: Jungle Bell 웹·PWA·Tauri 대시보드

대시보드는 React와 Tailwind CSS로 구성하며, shadcn/ui 컴포넌트를 저장소 안에 복사해 재사용한다. 급식 이미지는 별도 화면을 만들지 않고 검증된 원본 URL을 새 탭에서 연다.

## 소스 경계

| 역할 | 위치 |
| --- | --- |
| React 진입점과 provider | [`src/app`](../src/app) |
| 화면 셸과 hash route | [`src/app/shell`](../src/app/shell), [`src/app/routes.ts`](../src/app/routes.ts) |
| 화면별 기능 | [`src/features`](../src/features) |
| 공유 화면 컴포넌트 | [`src/components/dashboard`](../src/components/dashboard) |
| 저장소에 포함한 shadcn/ui | [`src/components/ui`](../src/components/ui) |
| Tailwind·색상 토큰 | [`src/app/styles/globals.css`](../src/app/styles/globals.css) |
| 정적 Markdown 블로그 | [`src/site`](../src/site) |

## 대시보드 셸

- `md` 이상에서는 232px 사이드바와 상단 헤더를 사용한다.
- 작은 화면에서는 상단 브랜드 영역과 하단 고정 내비게이션을 사용한다.
- 공개 웹은 `home`, `laundry`, `meals`만 노출한다.
- PC 앱과 PWA의 주요 내비게이션은 오늘·출석·세탁실·급식으로 한정한다.
- 알림 센터와 기기 연결은 주요 기능과 분리한다. 넓은 화면에서는 사이드바 하단의 개인 도구 영역, 작은 화면에서는 헤더 버튼으로 연다.
- 본문 최대 폭은 90rem이며, 모바일 safe area를 포함해 하단 내비게이션과 겹치지 않게 여백을 둔다.

## 디자인 토큰

색상과 radius는 [`globals.css`](../src/app/styles/globals.css)의 CSS 변수 한곳에서 관리한다. 기본 강조색은 Jungle Bell의 leaf green이며 카드·입력·상태 표시는 shadcn/ui 변형을 사용한다. 시스템 `prefers-color-scheme`에 따라 light/dark 토큰을 바꾸고, 개별 화면에서 별도 팔레트를 만들지 않는다.

폰트는 번들된 Pretendard Variable을 사용한다. 상태는 색만으로 구분하지 않고 본문 텍스트와 아이콘으로 전달하며, 조치가 필요한 경우에만 알림을 표시한다.

## WashTower 예외

세탁 화면의 WashTower 표는 제품 고유 컴포넌트이므로 일반 shadcn 표로 대체하지 않는다. 다음 계약을 유지한다.

- 기기 번호가 열이며 건조기는 위, 세탁기는 아래에 표시한다.
- 1–5번 남성, 6–7번 공용, 8–9번 여성 구역색을 사용한다.
- 사용 가능 `✓`, 오류 `!`, 사용 중 `HH:MM`, 정보 없음 `--:--`를 표시한다.
- 모바일에서는 표를 축소하지 않고 가로 스크롤로 전체 구조를 보존한다.

## Astro 블로그 경계

Markdown 블로그는 같은 루트 패키지와 `src/` 아래에서 관리하지만 React 앱에 포함하지 않는다. Astro가 정적 HTML을 `.build/site`에 만들고 조립 스크립트가 최종 `dist/blog`에 합친다. 블로그 소스에는 React import나 `client:*` hydration 지시어를 넣지 않는다.

## 불변 조건

- 서버 응답은 기존 strict parser를 통과한 뒤 React Query cache에 저장한다.
- Tauri IPC는 기존 capability와 Rust 검증 경계를 넓히지 않는다.
- 공개 웹에서 개인 출석·알림·설정 API를 호출하지 않는다.
- 공통 상태, 버튼, 카드, dialog는 `src/components`에서 재사용한다.
- 블로그 빌드는 React 번들을 로드하지 않는다.
