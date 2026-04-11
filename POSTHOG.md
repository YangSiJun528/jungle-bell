# PostHog 연동 가이드

## 개요

`POSTHOG_API_KEY` 환경변수가 설정된 경우에만 활성화됩니다.
미설정 시 모든 이벤트 전송이 비활성화됩니다 (no-op).

## 수집 이벤트

| 이벤트 | 발생 시점 |
|---|---|
| `settings_opened` | 트레이 → 설정 창 열 때 |
| `attendance_page_opened` | 트레이 → 출석 페이지 열 때 |
| `attendance_completed` | 출석 상태가 `false → true`로 전이할 때 (morning/evening 각각 최대 1일 1회) |

### 이벤트 프로퍼티

- 모든 이벤트: `app_version` (빌드 시 `CARGO_PKG_VERSION`에서 주입)
- `attendance_completed`: `period` = `"morning"` 또는 `"evening"`

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

> ⚠️ **중요 — 키가 바이너리에 임베드됩니다.**
> `option_env!("POSTHOG_API_KEY")`로 컴파일 시점에 값이 바이너리 문자열 섹션에
> 포함되므로 배포된 실행 파일에서 `strings` 등으로 **추출 가능합니다.**
>
> - PostHog의 **Project API key (`phc_*`)** 는 공개 전제(클라이언트 SDK에서 사용)이므로 임베드해도 무방합니다.
> - **Personal API key**, **Feature Flag secure key**, 기타 write-all 권한 키는 **절대 사용하지 마세요.**
> - 키 노출이 문제되는 경우, PostHog 대시보드의 **Authorized URLs** 및 이벤트 필터링으로 오남용을 차단하세요.

### 2. 빌드 시 키 전달

```bash
POSTHOG_API_KEY="phc_xxxxxxxxxxxx" cargo tauri dev
POSTHOG_API_KEY="phc_xxxxxxxxxxxx" cargo tauri build
```

또는 `.cargo/config.toml`에 저장 (git 커밋 금지):

```toml
[env]
POSTHOG_API_KEY = "phc_xxxxxxxxxxxx"
```

### 3. EU 서버 사용 시

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
