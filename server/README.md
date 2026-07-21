# Jungle Bell server

세탁기 상태와 카카오 채널 식단 데이터를 수집하고 공개 API로 제공하는 서버입니다. Cloudflare 배포 코드는 Hono Worker 두 개로 나뉩니다.

- `collector-worker`: 매분 원본 3개를 순차 요청하고 D1과 R2에 저장합니다.
- `api-worker`: 최신 상태, 분 단위 이력, 이벤트, 식단, 이미지를 캐시 가능한 HTTP API로 제공합니다.
- `local-collector`: 같은 수집 코어를 파일시스템 어댑터로 실행하는 홈서버 백업입니다.

수집 코어는 저장소를 직접 알지 못합니다. `CollectorStorage`를 호출하고, Cloudflare에서는 D1/R2 어댑터가, 로컬에서는 JSON 파일 어댑터가 실제 저장을 담당합니다.

원본 전체 JSON은 RFC 8785 방식으로 정규화한 뒤 SHA-256을 계산합니다. 직전 SHA와 같으면 원본, 정규화본, 이미지는 다시 저장하지 않고 해당 분의 관측 결과와 실행 로그만 남깁니다. 카카오의 pinned 포함 API와 기본 API는 응답이 같아도 별도 소스로 기록합니다.

## 문서

- [Cloudflare 배포](docs/guide-deploy-cloudflare.md)
- [로컬 백업 실행](docs/guide-run-local-backup.md)
- [HTTP API 레퍼런스](docs/api-reference.md)

## 검증

```bash
npm ci
npm run check
npm run build
```
