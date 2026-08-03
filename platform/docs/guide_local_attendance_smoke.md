# 로컬 출석 동기화 smoke 실행하기

이 가이드는 Tauri가 로컬 LMS WebView에서 출석을 읽고 정규화된
snapshot·heartbeat만 서버에 동기화하는 경로를 실제 계정으로
확인합니다. 서버가 LMS를 주기적으로 호출하는 구조가 아닙니다.

Google 계정 입력과 2단계 인증은 자동화하지 않습니다. 출석
체크인·체크아웃을 생성하거나 변경하지 않고 조회 API만 사용합니다.
Jungle Bell은 자동 출석 기능을 제공하지 않습니다.

## 준비 사항

- [실계정 LMS 로그인 smoke](guide_lms_login_smoke.md)를 통과한 Tauri
- API·웹·Tauri가 실행 중인 로컬 환경
- 실제 Jungle LMS 계정
- 테스트하는 동안 PC를 절전하지 않을 수 있는 환경

## 1. 공개 API와 PC 연결을 확인합니다

```bash
curl --fail http://127.0.0.1:8787/api/health
curl --fail http://127.0.0.1:8787/api/public/campus/laundry
curl --fail http://127.0.0.1:8787/api/public/campus/meals
```

Tauri main 화면은 `LMS 연결됨`이어야 합니다. 연결 직후 agent가 즉시 한
번 수집하고, 이후 약 5분마다 다시 수집합니다. heartbeat는 약 30초,
desktop notification inbox는 약 15초 간격입니다.

## 2. 첫 snapshot을 확인합니다

1. main 화면에서 출석 기준일이 KST의 기대 날짜인지 확인합니다.
2. cohort ID·상태·기간이 실제 계정과 맞는지 확인합니다.
3. 오전·오후 출석 상태가 Jungle LMS 화면과 같은지 비교합니다.
4. `마지막 동기화` 시각이 현재 수집 시각과 가까운지 확인합니다.
5. 최대 5분을 조금 넘겨 기다린 뒤 마지막 동기화 시각이 다시
   갱신되는지 확인합니다.

DB에서는 snapshot 내용과 민감 값을 한꺼번에 출력하지 말고 집계만
확인합니다.

```bash
sqlite3 -readonly .data/jungle-bell.sqlite \
  "SELECT
     COUNT(*) AS snapshots,
     MAX(received_at_epoch_ms) AS last_received,
     COUNT(DISTINCT user_id) AS users,
     COUNT(DISTINCT source_device_id) AS source_devices
   FROM attendance_snapshots;"
```

서버에 LMS session·collector run table이 없어야 합니다.

```bash
sqlite3 -readonly .data/jungle-bell.sqlite \
  "SELECT COUNT(*) FROM sqlite_schema
   WHERE type='table'
     AND name IN ('lms_sessions','attendance_collector_runs');"
```

결과는 `0`이어야 합니다.

## 3. 모바일 조회를 확인합니다

1. PC에서 QR 또는 10자리 코드로 모바일 PWA를 연결합니다.
2. PC에서 본 출석 기준일·cohort·오전·오후 상태가 모바일 `/app`과
   같은지 확인합니다.
3. PC를 종료한 뒤 모바일 화면을 새로고침합니다.
4. 마지막 저장 snapshot은 조회되지만 PC 상태와 freshness가 stale로
   전환되는지 확인합니다.
5. PC를 다시 실행하면 heartbeat와 새 snapshot 이후 상태가 회복되는지
   확인합니다.

모바일은 LMS를 직접 호출하지 않습니다. PC가 오래 꺼져 있어도 서버는
과거 snapshot을 오늘의 새 값으로 추측하지 않습니다.

## 4. access JWT 갱신을 관찰합니다

Jungle LMS에 별도 refresh endpoint가 없으므로 access cookie를 임의로
삭제하거나 refresh cookie를 서버로 옮기는 방식으로 시험하지 않습니다.

1. PC와 Tauri를 켠 상태로 access JWT의 통상 수명보다 오래 유지합니다.
2. 그 사이 5분 주기의 일반 `/api/v2/me`, cohort, 출석 요청이 계속
   성공하는지 마지막 동기화 시각으로 확인합니다.
3. access JWT가 갱신되는 동안 서버 DB와 API log에 access·refresh
   cookie가 생기지 않는지 확인합니다.
4. Tauri를 재시작한 뒤에도 WebView profile의 refresh cookie로 일반 LMS
   요청이 이어지는지 확인합니다.
5. refresh cookie까지 만료된 경우 Tauri와 모바일에 `LMS 로그인 필요`
   상태가 표시되는지 확인합니다.

갱신 성공 여부는 cookie 값을 출력해 비교하지 않습니다. 일반 조회의
지속 성공, snapshot 시각 갱신, 서버 무보관을 함께 증거로 사용합니다.

## 5. 최신 snapshot 충돌 규칙을 확인합니다

같은 LMS 계정을 검증한 PC가 두 대 있을 때만 수행합니다.

1. 두 PC에서 출석 동기화를 실행합니다.
2. 더 늦은 `collectedAt`을 가진 snapshot이 dashboard에 표시되는지
   확인합니다.
3. 먼저 수집한 PC가 나중에 네트워크에서 복귀해 오래된 snapshot을
   보내도 최신 값이 되돌아가지 않는지 확인합니다.
4. 한 PC를 연동 해제해도 다른 PC의 최신 snapshot과 heartbeat가
   유지되는지 확인합니다.

서버 수신 시각이 아니라 PC가 LMS를 관측한 `collectedAt`이 우선순위
기준입니다. 미래로 5분을 넘는 client 시각은 거부됩니다.

## 6. 출석 알림 경계를 확인합니다

실제 알림을 받으려면 개인 설정에서 출석 알림 전체와 오전 또는 오후를
명시적으로 켭니다. 기본값은 꺼짐입니다.

- server lifecycle이 snapshot upload와 독립적으로 due 사용자를 매분 확인
- 오전은 KST 09:50·10:00, 오후는 다음 날 03:50·04:00 두 slot만 사용
- 사용자·출석 날짜·phase·slot별 durable dedupe
- 활성 cohort의 15분 이내 미완료 snapshot에는 확인된 미완료 알림
- 같은 날짜에서 이미 완료된 phase에는 snapshot freshness와 관계없이 알림
  없음
- 오래된 `upcoming`·`ended` snapshot도 cohort 날짜가 해당 출석일을 범위
  밖으로 증명하면 알림 없음
- PC offline, LMS 로그인 필요, 오늘 snapshot 없음, stale 미완료 snapshot에는
  미완료를 단정하지 않는 `상태 미확인` fallback 알림
- 유효한 모바일 Web Push session과 유효한 app session의 desktop만
  전달 대상이며, 오프라인 desktop delivery는 event 만료까지만 유지

fallback을 확인하려면 출석 알림을 켠 테스트 사용자에서 reminder window
전에 Tauri를 종료하거나 snapshot을 15분 넘게 갱신하지 않습니다. 해당
slot에 모바일 Web Push가 `PC 오프라인` 또는 snapshot 상태 미확인 원인을
표시하고, 서버가 LMS 요청이나 출석 변경 요청을 만들지 않는지 확인합니다.
신선한 완료 snapshot을 올린 같은 사용자에게는 해당 phase 알림이 없어야
합니다.

자동 테스트는 planner·outbox 계약을 검증하지만 실제 운영체제
notification과 Apple·Google Push 전달은 수동으로 확인합니다.

## 7. 연동 해제 후 동작을 확인합니다

Tauri에서 `LMS 연동 해제`를 누릅니다.

- 해당 PC가 더 이상 heartbeat와 snapshot을 보내지 않습니다.
- local LMS access·refresh cookie와 subject binding이 제거됩니다.
- 서버에 이미 저장된 마지막 snapshot은 이력으로 남지만 freshness가
  낮아집니다.
- 다른 PC가 연결되어 있으면 그 PC의 동기화는 계속됩니다.
- 다시 같은 계정으로 로그인하면 기존 서버 사용자에 연결됩니다.

## 실패 판독

| 현상 | 확인할 항목 |
| --- | --- |
| 로그인됐지만 snapshot이 없음 | hidden LMS WebView agent, cohort 선택, 출석 응답 schema |
| 약 5분 뒤에도 시각이 안 바뀜 | app 절전, collection trigger, LMS network |
| access 만료 후 중단 | WebView의 refresh cookie 상태와 LMS 일반 API 응답 |
| 모바일만 오래된 값 | PC heartbeat, snapshot freshness, mobile session 상태 |
| 과거 snapshot이 최신 값을 덮음 | `collectedAt` 비교와 client clock |
| 같은 알림이 반복됨 | source-event slot dedupe, delivery ack, lease 만료 |

실패 로그에 LMS ID, cookie, app session 원문을 남기지 마십시오.
