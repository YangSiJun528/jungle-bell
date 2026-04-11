# PostHog 연동 가이드

## 개요

`POSTHOG_API_KEY` 환경변수가 설정된 경우에만 활성화됩니다.
미설정 시 모든 이벤트 전송이 비활성화됩니다 (no-op).

## 수집 이벤트

| 이벤트 | 발생 시점 |
|---|---|
| `settings_opened` | 트레이 → 설정 창 열 때 |
| `attendance_page_opened` | 트레이 → 출석 페이지 열 때 |
| `attendance_check_attempted` | 출석 체크 API 조회 성공 시 (api_error 제외) |

### 이벤트 프로퍼티

모든 이벤트에 `app_version`이 포함됩니다.

### distinct_id

- **로그인 상태**: `/api/v2/me`의 사용자 `id`를 SHA-256으로 해시하여 사용
- **미로그인 상태**: `"anonymous"` 고정값 사용 (비중 파악용)

identity는 checker.js에서 cohort 조회 성공 후 `/api/v2/me`를 호출해 자동 설정됩니다.

---

## 연동 방법

### 1. PostHog 계정 및 API 키 확인

1. [https://posthog.com](https://posthog.com) → **Get started for free**
2. 로그인 후: **Settings → Project settings → Project API key** (`phc_xxx` 형식)

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
