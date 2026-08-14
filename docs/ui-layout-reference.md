# UI 구조 참고 자료

> 문서 유형: 참조(reference)
>
> 확인일: 2026-08-12
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

## 대시보드 셸

- `md` 이상에서는 shadcn/ui의 기본 16rem 사이드바를 사용한다. `SidebarRail`을
  좌우로 드래그하거나 방향키·Home·End를 눌러 12–24rem 범위에서 폭을 조절한다.
  조절값은 현재 화면에만 적용하고 별도 브라우저 저장값은 두지 않는다.
  `SidebarTrigger`와 `SidebarRail` 클릭으로 3rem 아이콘 모드까지 접고 펼치며,
  `Cmd+B` 또는 `Ctrl+B` 단축키도 공통 `SidebarProvider`가 처리한다.
- 작은 화면에서는 상단 `SidebarTrigger`가 shadcn/ui의 모바일 `Sheet`를 열고, 하단
  고정 내비게이션도 유지한다.
- 브라우저와 PC 앱은 홈·출석·세탁실·식단의 같은 주요 내비게이션을 사용한다.
- 알림 센터와 기기 연결은 주요 기능과 분리한다. 넓은 화면에서는 사이드바 하단의
  개인 도구 영역, 작은 화면에서는 헤더 버튼으로 연다.
- 알림 센터의 기본 탭에는 새 알림만 표시한다. 본 알림으로 처리한 항목은 즉시 기본
  탭에서 숨기고 지난 알림 탭에서 다시 확인할 수 있다.
- 개인 화면의 사이드바 알림 항목은 `SidebarMenuBadge`로 읽지 않은 개수를 표시한다.
  뱃지는 실제 개수를 그대로 표시하고 버튼의 접근성 이름에도 같은 개수를 포함한다.
- 본문 최대 폭은 72rem이며, 모바일 safe area를 포함해 하단 내비게이션과 겹치지
  않게 여백을 둔다.

## 캘린더 의존성

저장소의 shadcn/ui `Calendar`는 `react-day-picker`를 감싼 컴포넌트다. 급식 기록의
월 이동, 단일 날짜 선택, 기록 없는 날짜 비활성화, 한국어 locale, 시간대와 키보드
접근성을 이 계층에서 제공하므로 `react-day-picker`와 `date-fns` 의존성을 유지한다.

급식 기능의 `MealHistoryCalendar`는 한국 표준시 기준 날짜, 기록이 있는 날짜와 선택
상태만 전달한다. 월을 이동하면 해당 `YYYY-MM` 기록을 자동 조회하며 별도의 이전
기록 불러오기 버튼을 두지 않는다. 월 그리드나 포커스 이동을 별도로 재구현하지 않는다. shadcn/ui의
Calendar를 갱신할 때도 공식 DayPicker 기반 구조와 `buttonVariants` 내비게이션
스타일을 따르고, 급식 캘린더의 월 이동·선택·비활성 날짜 회귀 테스트를 함께
실행한다.

## 디자인 토큰

색상과 radius는 [`globals.css`](../src/app/styles/globals.css)의 CSS 변수 한곳에서 관리한다. 기본 강조색은 Jungle Bell의 leaf green이며 카드·입력·상태 표시는 shadcn/ui 변형을 사용한다. 시스템 `prefers-color-scheme`에 따라 light/dark 토큰을 바꾸고, 개별 화면에서 별도 팔레트를 만들지 않는다.

폰트는 번들된 Pretendard Variable을 사용한다. 상태는 색만으로 구분하지 않고 본문 텍스트와 아이콘으로 전달하며, 조치가 필요한 경우에만 알림을 표시한다.

## WashTower 예외

세탁 화면의 WashTower 표는 제품 고유 컴포넌트이므로 일반 shadcn 표로 대체하지 않는다. 다음 계약을 유지한다.

- 기기 번호가 열이며 건조기는 위, 세탁기는 아래에 표시한다.
- 1–5번 남성, 6–7번 공용, 8–9번 여성 구역색을 사용한다.
- 사용 가능 `✓`, 경고 삼각형, 사용 중 `HH:MM`, 정보 없음 `--:--`를 표시한다.
- 보정 시간이 끝나고 LG ThinQ API의 완료 확인을 기다리는 상태는 가득 찬 초록색
  진행 표시와 정보 안내로 구분한다.
- 남성·공용·여성 구역의 뱃지, 상태 셀과 용량 카드는 같은 구역 색상 메타데이터를
  사용한다. 경고는 여성 구역색과 다른 저채도 빨간색을 사용한다.
- 모바일에서는 표를 축소하지 않고 가로 스크롤로 전체 구조를 보존한다.

## 불변 조건

- 서버 응답은 기존 strict parser를 통과한 뒤 React Query cache에 저장한다.
- Tauri IPC는 기존 capability와 Rust 검증 경계를 넓히지 않는다.
- 계정 API는 브라우저의 HttpOnly cookie 또는 Tauri의 메모리 전용 단기 token으로만 호출한다.
- 공통 상태, 버튼, 카드, dialog는 `src/components`에서 재사용한다.
