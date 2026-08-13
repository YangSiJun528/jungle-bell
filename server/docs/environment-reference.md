# 서버 환경 변수 레퍼런스

OCI 배포에서는 `server/deploy/.env.v2-test`에 비밀이 아닌 설정만 두고, secret 값은
별도 파일로 관리합니다. Spring Boot는 `/run/secrets`의 config tree와 환경 변수를
함께 읽습니다.

## 데이터베이스

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | `jdbc:postgresql://localhost:5432/jungle_bell` | JDBC URL |
| `DATABASE_USERNAME` | `jungle_bell` | PostgreSQL 사용자 |
| `DATABASE_PASSWORD` | config tree `database-password` | 로컬 직접 실행용 비밀번호 |
| `DATABASE_POOL_MAX` | `10` | Hikari 최대 connection 수 |
| `DATABASE_POOL_MIN` | `2` | Hikari 최소 idle connection 수 |
| `POSTGRES_DB` | `jungle_bell` | Compose PostgreSQL database |
| `POSTGRES_USER` | `jungle_bell` | Compose PostgreSQL 사용자 |
| `DATABASE_PASSWORD_FILE` | 필수 | Compose secret 파일의 절대 경로 |

`schema.sql`은 시작할 때 idempotent `CREATE TABLE IF NOT EXISTS`로 적용됩니다. 현재
단계에는 migration 파일이 없으므로 호환되지 않는 변경은 새 volume을 사용합니다.

## HTTP와 인증

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8080` | Spring HTTP port |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8080` | 정적 자산과 공개 API의 외부 origin |
| `PAIRING_SECRET` | config tree `pairing-secret` | pairing 서명 secret, 32자 이상 |
| `PAIRING_SECRET_FILE` | 필수 | Compose pairing secret 파일 |
| `JUNGLE_BELL_LOG_LEVEL` | `INFO` | 앱 package 로그 수준 |

Desktop UI origin allowlist는 코드에서 고정합니다.

- `tauri://localhost`
- `http://tauri.localhost`
- `http://127.0.0.1:5173`

`CF-Connecting-IP`는 enrollment rate limit의 client key로만 사용하며, 값은 hash한 뒤
저장합니다. header가 없으면 socket remote address를 사용합니다.

## 수집기

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `COLLECTORS_ENABLED` | `false` | 세탁·급식 수집과 후속 automation 실행 여부 |
| `LAUNDRY_SOURCE_URL` | 없음 | 내부 LG ThinQ 수집 source URL |
| `MEALS_PINNED_SOURCE_URL` | 없음 | 고정 글을 포함한 카카오 채널 URL |
| `MEALS_DEFAULT_SOURCE_URL` | 없음 | 일반 카카오 채널 URL |

수집기는 세탁은 매분, 급식은 scheduler 정의 주기마다 실행합니다. 각 source의 최근
시도·성공·실패는 `source_state`에 저장되고 `/api/public/status`에 노출됩니다.

## Web Push

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | config tree `vapid-public-key` | 브라우저 구독용 공개키 |
| `VAPID_PRIVATE_KEY` | config tree `vapid-private-key` | OCI에만 두는 private key |
| `VAPID_SUBJECT` | 없음 | `mailto:` 또는 HTTPS subject |
| `VAPID_PUBLIC_KEY_FILE` | 필수 | Compose public key 파일 |
| `VAPID_PRIVATE_KEY_FILE` | 필수 | Compose private key 파일 |

private key는 저장소, PostgreSQL, 로그에 기록하지 않습니다. key pair와 subject가 모두
있을 때만 Push 전송을 활성화합니다.

## Compose 전용 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `APP_IMAGE` | `jungle-bell-server:v2-test-local` | 빌드·실행 이미지 tag |
| `APP_PORT` | `8080` | 호스트 loopback port |
| `CLOUDFLARE_TUNNEL_TOKEN` | 없음 | 선택적인 named Tunnel token |

`CLOUDFLARE_TUNNEL_TOKEN`은 ingress용일 뿐입니다. 서버 실행이나 데이터 저장에는
Cloudflare 서비스가 필요하지 않습니다. token이 없으면 `quick-tunnel` profile로
임시 URL을 만들 수 있습니다.
