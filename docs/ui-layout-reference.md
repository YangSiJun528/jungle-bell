# UI 레이아웃 참고 자료

> 문서 유형: 참조(reference)
>
> 확인일: 2026-08-03
>
> 대상: Jungle Bell 웹·PWA·Tauri WebView의 공통 UI 셸

이 문서는 페이지 외곽 여백, 스크롤바, 공통 헤더·푸터의 레이아웃 계약을 정의한다. 여기서 사이드바는 메뉴 영역이 아니라 **페이지 우측 스크롤바**를 뜻한다.

## 외곽 여백

일반 페이지의 콘텐츠는 뷰포트 좌우에서 각각 총 16px 떨어진다. 우측 16px에는 8px 스크롤바 gutter가 포함된다.

| 항목 | 값 | 구현 |
| --- | ---: | --- |
| 총 좌측 외곽 여백 | 16px | 8px stable gutter + 8px body 여백 |
| 총 우측 외곽 여백 | 16px | 8px body 여백 + 8px 스크롤바 gutter |
| 스크롤바 폭 | 8px | `--scrollbar-size: var(--space-2)` |
| 페이지 gutter | 16px | `--page-gutter: var(--space-4)` |
| 실제 body 좌우 padding | 8px | `page-gutter - scrollbar-size` |

[`ui.css`](../src/ui.css)의 `html`은 `scrollbar-gutter: stable both-edges`를 사용한다. 페이지가 짧아도 gutter를 유지하므로 스크롤 발생 여부에 따라 본문 정렬이 움직이지 않는다. `body`의 좌우 padding은 다음 식으로 계산한다.

```css
padding-inline: calc(var(--page-gutter) - var(--scrollbar-size));
```

`data-page-layout="bleed"`인 이미지 뷰어와 시스템 보조 표면은 일반 페이지 콘텐츠가 아닌 전체 화면 표면이다. 이 표면은 명시적으로 stable gutter 계약에서 제외된다.

## 공통 고정 영역

페이지별로 반복하지 않는 셸 영역은 공통 컴포넌트 역할을 사용한다.

| 역할 | 클래스 | 책임 |
| --- | --- | --- |
| 앱 셸 헤더 | `ui-app-header` | 셸 상단의 공통 정렬과 최소 높이 |
| 앱 셸 푸터 | `ui-app-footer` | 셸 하단의 공통 정렬과 최소 높이 |
| 페이지 헤더 | `ui-page-header` | 설정·온보딩·생활 정보처럼 페이지 내부 제목 영역 |

대시보드의 `attendance`, `laundry`, `meals`, `notifications`, `connections`는 각각 헤더와 푸터를 만들지 않는다. [`dashboard.html`](../src/dashboard.html)은 다섯 경로 바깥에 `ui-app-header`와 `ui-app-footer`를 각각 한 번만 선언하고 모든 경로가 같은 셸을 사용한다. 경로별 제목은 본문 안의 `dashboard-page-intro`가 담당한다.

## 구현 위치

| 계약 | 소스 | 검증 |
| --- | --- | --- |
| 전역 16px gutter와 8px 스크롤바 | [`ui.css`](../src/ui.css) | [`layout-contract.test.ts`](../src/layout-contract.test.ts), [`ui-foundation.test.ts`](../src/ui-foundation.test.ts) |
| 대시보드 외곽 여백 상속 | [`dashboard.css`](../src/dashboard.css) | [`layout-contract.test.ts`](../src/layout-contract.test.ts) |
| 공통 셸 헤더·푸터 구조 | [`dashboard.html`](../src/dashboard.html) | [`layout-contract.test.ts`](../src/layout-contract.test.ts) |

## 불변 조건

- 일반 페이지는 `--page-gutter` 또는 전역 body padding을 페이지별 고정값으로 덮어쓰지 않는다.
- 스크롤 가능한 일반 페이지의 우측 16px는 콘텐츠 여백 8px와 스크롤바 gutter 8px의 합이다.
- 반응형 구간에서도 외곽 여백을 16px 미만으로 줄이지 않는다.
- 여러 경로가 공유하는 헤더·푸터는 경로별 section 밖의 셸에 한 번만 둔다.
- 전체 화면 표면은 `data-page-layout="bleed"`로 예외를 명시한다.
