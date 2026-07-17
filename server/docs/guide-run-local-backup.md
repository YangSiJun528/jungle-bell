# 로컬 백업 수집기 실행하기

이 문서는 홈서버에서 Cloudflare와 별개로 원본 JSON과 이미지를 파일로 백업하는 절차입니다.

## 1. 설정

로컬 설정 파일을 생성합니다. `.env`는 Git에 포함되지 않습니다.

```bash
cp .env.example .env
```

기본값은 호스트의 `./data`에 저장하며 파일을 자동으로 삭제하지 않습니다. 다른 디스크를 사용할 때는 `LOCAL_DATA_DIR`을 수정합니다. URL, 타임아웃, LG 상태 목록도 같은 파일에서 설정합니다.

```dotenv
LOCAL_DATA_DIR=./data
```

Compose가 읽은 최종 설정은 실행 전에 확인할 수 있습니다.

```bash
docker compose config
```

## 2. 실행

```bash
docker compose up --detach --build
```

Supercronic이 매분 다음 명령을 실행합니다.

```text
node /app/dist/local/index.js collect --data-dir /data
```

Supercronic의 기본 비중첩 실행을 사용하므로 이전 수집이 끝나기 전에 같은 작업을 겹쳐 실행하지 않습니다.

## 3. 상태 확인

```bash
docker compose ps
docker compose logs --follow collector
```

수집 결과는 `LOCAL_DATA_DIR`로 지정한 호스트 디렉터리에 남습니다. 기본 경로는 `server/data`입니다.

```text
data/
  raw/<source>/YYYY/MM/DD/       변경된 원본 전체 JSON
  observations/YYYY/MM/DD/       매분 성공 또는 실패 관측
  events/YYYY/MM/DD/             세탁 상태와 ETA 변경 이벤트
  versions/                      관측 시점별 정규화본
  assets/                        SHA-256 주소 기반 식단 이미지
  media-map/                     카카오 media ID와 이미지 SHA 매핑
  latest/                        최신 원본 및 정규화본
  state/sources/                 소스별 마지막 정상 수집 상태
  logs/YYYY-MM-DD.jsonl          LogTape 구조화 로그
```

모든 시각과 날짜 경로는 UTC입니다.

## 4. 수동 보존 관리

원본 JSON, 관측 이력, 이미지, 로그는 자동 삭제 없이 계속 보관됩니다. 디스크 사용량을 주기적으로 확인하고 필요할 때 호스트에서 날짜 디렉터리를 수동으로 삭제합니다.

```bash
du -sh ./data
du -sh ./data/* | sort -h
```

`latest`, `state`, `media-map`은 현재 상태 복구에 필요하므로 삭제하지 않습니다. `raw`, `observations`, `events`, `logs`는 날짜 경로 또는 날짜 파일 단위로 정리할 수 있습니다. `assets`, `indexes`, `versions`는 다른 데이터가 참조할 수 있으므로 참조 관계를 확인하지 않고 삭제하면 백업이 불완전해질 수 있습니다.

crontab 문법은 다음처럼 검사합니다.

```bash
docker compose run --rm --entrypoint /usr/local/bin/supercronic collector -test /etc/jungle-bell/crontab
```
