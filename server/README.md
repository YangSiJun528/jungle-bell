# Jungle Bell server

세탁기 상태와 카카오 채널 식단 데이터를 수집하고 Cloudflare API로 제공하는 서버입니다.

- `src/collector/`: 수집, 정규화, 투영 로직입니다.
- `src/node/`: OCI에서 실행되는 Collector와 D1 REST/R2 S3 저장기입니다.
- `src/storage/`: 수집 commit을 D1 조회 모델로 변환하는 공용 query builder입니다.
- `src/workers/api.ts`: D1/R2를 읽어 캐시 가능한 HTTP API를 제공하는 Cloudflare Worker입니다.
- `src/workers/`: API Worker의 D1/R2 조회 어댑터와 로깅을 관리합니다.

OCI Collector는 세탁실을 매분, 카카오 API 두 개를 5분마다 한 프로세스 안에서 순차 요청합니다. 원본 JSON, 정규화본, 이미지, 수집 commit은 R2 S3 API로 저장하고 상태, 분 단위 관측, 세탁 이벤트, 식단 인덱스는 D1 REST API batch로 직접 저장합니다. Cloudflare Collector Worker와 Ingest Worker는 사용하지 않습니다.

원본 전체 JSON은 RFC 8785 방식으로 정규화한 뒤 SHA-256을 계산합니다. 직전 SHA와 같으면 원본, 정규화본, 이미지는 다시 저장하지 않고 해당 분의 관측 결과와 실행 로그만 남깁니다. 카카오의 pinned 포함 API와 기본 API는 응답이 같아도 별도 소스로 기록합니다.

식단 게시물의 본문은 API 조회 모델인 D1 `meal_post`, 이미지 메타데이터는 `meal_image`에 누적합니다. 카카오 최신 목록에서 게시물이 사라져도 이 레코드는 삭제하지 않습니다. 원본 JSON 버전, 수집 commit, 실제 이미지 파일은 복구용으로 R2에 계속 보관합니다.

## 내부 운영

- [배포와 장애 대응 런북](OPERATIONS.md)
- [HTTP API 레퍼런스](docs/api-reference.md)

## D1 초기화

현재 `schema.sql`만 지원하며 마이그레이션과 구버전 호환은 제공하지 않습니다. 실행하면 D1의 기존 테이블과 데이터가 모두 삭제된 뒤 현재 스키마로 다시 생성됩니다. R2와 로컬에 보관한 원본 JSON 및 이미지는 삭제되지 않습니다.

```bash
npm run db:reset:remote
```

작은 필드 추가가 필요하면 별도 마이그레이션 체계를 만들지 않고 Wrangler로 SQL을 수동 실행한 뒤 `schema.sql`의 현재 구조도 함께 수정합니다. 과거 D1 구조를 코드에서 읽는 호환 분기는 추가하지 않습니다.

## 검증

```bash
npm ci
npm run check
```
