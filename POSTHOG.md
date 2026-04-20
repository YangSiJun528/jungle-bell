# PostHog 연동 가이드

## 개요

Project API Key가 `analytics.rs`에 하드코딩되어 **릴리스 빌드**에서만 활성화됩니다.
`cargo tauri dev` 등 `debug_assertions`이 켜진 개발 빌드에서는 이벤트가 전송되지 않습니다.

> **키 공개 여부:** PostHog의 **Project API key (`phc_*`)** 는 클라이언트 SDK 전용으로
> 공개 전제 설계입니다. 프론트엔드 JS·모바일 앱에 하드코딩하는 것이 표준 방식이며
> 소스코드에 포함해도 무방합니다. (참고: https://posthog.com/docs/api#authentication)

## 수집 이벤트

| 이벤트 | 발생 시점 |
|---|---|
| `settings_opened` | 트레이 → 설정 창 열 때 |
| `attendance_page_opened` | 트레이 → 출석 페이지 열 때 |
| `meal_plan_opened` | 트레이 → 식단표 보러가기 클릭 시 |
| `attendance_completed` | 출석 상태가 `false → true`로 전이할 때 (morning/evening 각각 최대 1일 1회) |

### 이벤트 프로퍼티

- 모든 이벤트:
  - `app_version` — 정글벨 앱 버전 (빌드 시 `CARGO_PKG_VERSION`에서 주입)
  - `$os` — 런타임 OS 이름 (예: `"Mac OS"`, `"Windows"`, `"Ubuntu"`)
- `attendance_completed`: `period` = `"morning"` 또는 `"evening"`

> `$os`는 PostHog 표준 메타데이터로 취급되어 대시보드 필터/차트에서 자동 인식됩니다.

> **Note:** `attendance_completed`는 스케줄러 틱마다가 아니라 **상태 전이시점**에만 발사합니다.
> 앱 재시작 직후의 최초 보고(`data_loaded=false`)는 "오늘 이미 완료된 출석"일 수 있어
> 중복 카운트 방지를 위해 이벤트 발사 대상에서 제외됩니다.

### distinct_id

- **로그인 상태**: `/api/v2/me`의 사용자 `id`를 SHA-256으로 해시하여 사용
- **미로그인 상태**: `"anonymous"` 고정값 사용 (비중 파악용)

identity는 checker.js에서 cohort 조회 성공 후 `/api/v2/me`를 호출해 자동 설정됩니다.

---

## 연동 방법

### 1. PostHog 계정 및 API 키 확인

1. [https://posthog.com](https://posthog.com) → **Get started for free**
2. 로그인 후: **Settings → Project settings → Project API key** (`phc_xxx` 형식)

> **참고 — 키가 바이너리에 임베드됩니다.**
> 배포된 실행 파일에서 `strings` 등으로 추출 가능하지만, Project API key는 공개 전제이므로 문제없습니다.
> **Personal API key**, **Feature Flag secure key** 등 write-all 권한 키는 절대 사용하지 마세요.

### 2. EU 서버 사용 시

`analytics.rs`의 클라이언트 초기화를 수정합니다:

```rust
let options = posthog_rs::ClientOptionsBuilder::default()
    .api_key(api_key.to_string())
    .host("https://eu.i.posthog.com")
    .build()
    .unwrap();
let client = posthog_rs::client(options).await;
```

기본값은 US 서버(`us.i.posthog.com`)입니다.

---

## 에러 처리 한계

posthog-rs 0.3은 HTTP 응답 status를 무시합니다. `.send()` 성공 시 무조건 `Ok(())`를 반환하므로 **401/400 에러는 로그에 찍히지 않습니다.** 연결 실패(네트워크 오류, 타임아웃)만 `[analytics] capture '...' failed:` 로그로 확인 가능합니다.

이벤트 수신 여부는 PostHog 대시보드 **Activity → Live events** 또는 **Activity → Events**에서 확인합니다.
