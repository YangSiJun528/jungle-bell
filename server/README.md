# Jungle Bell server

세탁기 상태와 카카오 채널 식단 데이터를 수집하고 공개 API로 제공하는 Cloudflare Workers 서버입니다.

- `src/collector-worker.ts`: 매분 원본 3개를 순차 요청하고 D1과 R2에 저장합니다.
- `src/api-worker.ts`: 최신 상태, 분 단위 이력, 이벤트, 식단, 이미지를 캐시 가능한 HTTP API로 제공합니다.
- `src/*.ts`: 수집, 정규화, 투영, 저장 코드를 별도 패키지 없이 한 디렉터리에서 관리합니다.

수집 로직은 `CollectorStorage` 계약을 호출하고 `CloudflareStorage`가 D1/R2 저장을 담당합니다. 이 계약은 수집 테스트에서 메모리 저장소를 사용할 수 있는 최소 경계로만 유지합니다.

원본 전체 JSON은 RFC 8785 방식으로 정규화한 뒤 SHA-256을 계산합니다. 직전 SHA와 같으면 원본, 정규화본, 이미지는 다시 저장하지 않고 해당 분의 관측 결과와 실행 로그만 남깁니다. 카카오의 pinned 포함 API와 기본 API는 응답이 같아도 별도 소스로 기록합니다.

식단 게시물의 본문은 D1 `meal_post`, 이미지 메타데이터는 `meal_image`에 누적합니다. 카카오 최신 목록에서 게시물이 사라져도 이 레코드는 삭제하지 않습니다. 원본 JSON 버전과 실제 이미지 파일은 복구용으로 R2에 계속 보관합니다.

## 문서

- [Cloudflare 배포](docs/guide-deploy-cloudflare.md)
- [HTTP API 레퍼런스](docs/api-reference.md)

## D1 스키마

마이그레이션 이력은 관리하지 않습니다. 현재 스키마는 `schema.sql` 하나가 기준이며 필요할 때 직접 적용합니다.

```bash
npm run db:schema:remote
```

## 검증

```bash
npm ci
npm run check
```
