# 환경 변수와 Cloudflare 바인딩 레퍼런스

API Worker와 OCI Collector는 실행 환경이 다릅니다. 기존 `server/.env`는
Collector 설정을 담고 있지만, Wrangler 로컬 개발은 같은 디렉터리의 `.env`도
Worker `env` 객체로 로드합니다. 다만 renewal Worker는 그 Collector 변수 이름을
사용하지 않으므로 동작에는 영향을 주지 않습니다. Worker에는 기존 Cloudflare
바인딩을 우선 사용하고, 기능상 필요한 값만 별도로 설정합니다.

## 기존 설정 재사용

| 이름 | 실행 환경 | 분류 | 용도 |
| --- | --- | --- | --- |
| `DB` | Worker | 기존 D1 바인딩 | 수집 데이터와 계정·세션·출석 snapshot 저장 |
| `DATA_BUCKET` | Worker | 기존 R2 바인딩 | 수집 원본과 급식 이미지 조회 |
| `CLOUDFLARE_ACCOUNT_ID` | Collector | 기존 환경 변수 | D1 REST API 계정 식별 |
| `CLOUDFLARE_D1_DATABASE_ID` | Collector | 기존 환경 변수 | Worker의 `DB`와 같은 D1 데이터베이스 식별 |
| `R2_BUCKET` | Collector | 기존 환경 변수 | Worker의 `DATA_BUCKET`과 같은 R2 버킷 식별 |

웹 자산과 `/v1` API는 같은 Worker에서 제공됩니다. 페어링 QR, credential CORS,
모바일 쿠키의 기준 origin은 요청 URL에서 결정하므로 `PUBLIC_ORIGIN` 환경 변수는
사용하지 않습니다. 기존 배포에 이 변수가 남아 있어도 동작에는 영향을 주지
않습니다.

## 신규 설정

| 이름 | 분류 | 필수 범위 | 관리 방법 |
| --- | --- | --- | --- |
| `PAIRING_SECRET` | Worker secret | QR·10자리 코드 연결 | 32바이트 이상의 난수. `wrangler secret put`으로 설정 |
| `VAPID_PUBLIC_KEY` | Worker 일반 변수 | 모바일 Web Push | Push relay의 VAPID 키 쌍에 대응하는 공개키 |
| `WEB_PUSH_RELAY` | Worker Service Binding | 모바일 Web Push 권장 구성 | Web Push relay Worker에 연결. URL·인증 토큰 불필요 |
| `WEB_PUSH_RELAY_URL` | Worker 일반 변수 | HTTP relay 대체 구성 | HTTPS relay endpoint |
| `WEB_PUSH_RELAY_TOKEN` | Worker secret | HTTP relay 대체 구성 | relay bearer token. `wrangler secret put`으로 설정 |

`PAIRING_SECRET`이 없으면 공개 급식·세탁 API는 계속 동작하지만 새 모바일 연결은
`503 PAIRING_SERVICE_UNAVAILABLE`로 차단됩니다. Web Push는
`VAPID_PUBLIC_KEY`와 relay가 모두 있을 때만 등록할 수 있습니다. Push 구성이
불완전하면 `503 WEB_PUSH_NOT_CONFIGURED`로 차단되며 구독 정보를 저장하지
않습니다.

## Push relay 선택 순서

Worker는 다음 순서로 sender를 선택합니다.

1. `WEB_PUSH_RELAY` Service Binding
2. `WEB_PUSH_RELAY_URL`과 `WEB_PUSH_RELAY_TOKEN` 조합
3. 미설정 상태

Service Binding을 사용할 때 `wrangler.api.jsonc`에 다음 바인딩을 추가합니다.
서비스 이름은 실제 relay Worker 이름으로 바꿉니다.

```jsonc
{
  "services": [
    {
      "binding": "WEB_PUSH_RELAY",
      "service": "jungle-bell-web-push-relay"
    }
  ]
}
```

Service Binding은 Cloudflare 런타임이 대상 Worker를 인증하므로 relay URL과 bearer
token을 중복 관리하지 않습니다. 외부 HTTPS relay를 사용해야 할 때만 URL과 token
방식을 사용합니다.

## 로컬 개발

Wrangler는 `.dev.vars`와 `.env` 중 하나만 사용합니다. `.dev.vars`가 있으면
`.env` 값은 Worker `env` 객체에 포함하지 않습니다. 자세한 로딩 규칙은
[Cloudflare Workers 환경 변수와 secret 문서](https://developers.cloudflare.com/workers/local-development/environment-variables/)를
참고합니다.

renewal Worker 로컬 개발에는 `server/.dev.vars.example`을 `.dev.vars`로 복사하고
신규 설정만 입력합니다. 이렇게 하면 Collector용 `server/.env`가 Worker에
들어오지 않지만 renewal Worker에는 필요하지 않으므로 기능 차이가 없습니다.
Collector는 기존 설정 방식을 그대로 사용합니다.

`.dev.vars`는 로컬 개발 전용이며 저장소에 커밋하지 않습니다. Production은
`wrangler.api.jsonc`의 일반 변수·D1·R2·Service Binding과
`wrangler secret put`으로 설정합니다.
`.dev.vars`, `.env`, `wrangler secret`의 실제 값은 로그와 저장소에 기록하지
않습니다.
