# 서버 로깅 레퍼런스

Jungle Bell 서버는 API와 Worker 로그에 동일한 필드 형식을 사용합니다. 로그 메시지는
영문으로 작성하고 HTTP 요청·작업 실행 식별자는 MDC에서 공통 출력합니다.

## 식별자

| 필드 | 설정 범위 | 값 |
| --- | --- | --- |
| `requestId` | 모든 HTTP 요청 | 안전한 `X-Request-ID` 또는 서버가 생성한 UUID |
| `jobRunId` | Scheduler 실행 | 실행마다 생성한 UUID |

HTTP 요청에는 `jobRunId=-`, Worker 작업에는 `requestId=-`가 출력됩니다. 사용자 UUID,
`tenantId`, `traceId`, `spanId`는 MDC에 넣지 않습니다.

`X-Request-ID`는 영문자 또는 숫자로 시작하는 1~64자의 영문자, 숫자, `.`, `_`, `:`,
`-`만 허용합니다. 누락되거나 형식이 맞지 않으면 요청을 거부하지 않고 UUID로
교체합니다. API는 최종 값을 모든 응답의 `X-Request-ID` header로 반환하고 CORS에
노출합니다.

## 출력 형식

API와 Worker는 Docker 표준 출력에 다음 Logback console pattern을 사용합니다.

```text
%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} level=%-5p requestId=%X{requestId:--} jobRunId=%X{jobRunId:--} thread=%thread source=%class.%method - %msg%n%ex
```

예시는 다음과 같습니다.

```text
2026-08-20T00:00:00.000+09:00 level=INFO requestId=client-123 jobRunId=- thread=http-nio-8080-exec-1 source=app.junglebell.server.api.pairing.PairingController.create - Pairing creation request completed. pairingId=jbp_... status=201
2026-08-20T00:01:00.000+09:00 level=INFO requestId=- jobRunId=3e... thread=scheduling-1 source=app.junglebell.server.worker.collector.CollectorScheduler.collectLaundry - Laundry collection job completed.
```

`%class.%method`는 호출 위치를 계산하므로 트래픽이나 CPU 사용량이 커지면 부하 테스트
결과를 기준으로 `%logger` 전환을 검토합니다.

## 레벨

| 레벨 | 사용 기준 |
| --- | --- |
| `DEBUG` | 조회 시작·종료, heartbeat, 알림 acknowledge, 정상 생략, 세부 단계 |
| `INFO` | 상태 변경 시작·종료, Scheduler 실행, 생성·전송·수집 결과 |
| `WARN` | 요청 거부, rate limit, 예상 가능한 충돌, fallback, 재시도 |
| `ERROR` | 최종 실패, 복구하면서 다음 단계로 진행하는 작업 실패, 운영 대응 필요 |

Controller는 받은 요청과 정상 HTTP 결과를 기록하고 Service는 수행한 업무와 업무
결과를 기록합니다. `Jdbc*Store`는 기본적으로 시작·종료를 기록하지 않습니다. private
계산 함수도 별도 시작·종료 로그 대상이 아닙니다.

## 예외 소유권

| 실패 위치 | 스택 기록 주체 |
| --- | --- |
| MVC까지 전파된 예상 오류 | `ApiErrorHandler`가 `WARN`, 스택 없음 |
| MVC까지 전파된 예상 밖 오류 | `ApiErrorHandler`가 `ERROR`와 스택 한 번 |
| 인증·인가 거부 | Security handler가 `WARN`, 스택 없음 |
| Worker 최종 실패 | Scheduler 경계가 `ERROR`와 스택 한 번 |
| Worker가 복구하고 계속 진행 | 복구한 단계가 스택 한 번 |

예외를 기록한 뒤 같은 예외를 다시 던지는 계층에서는 스택을 중복 기록하지 않습니다.
Web Push 예외는 endpoint 노출을 막기 위해 예외 class와 stack frame만 남기고 원본 message와
cause는 출력하지 않습니다.

## 기록 금지 데이터

다음 데이터는 메시지나 MDC에 기록하지 않습니다.

- 요청·응답 본문 전체, 사용자 UUID, IP 주소, 기기 label
- Authorization, Cookie, 비밀번호와 모든 secret
- `jbd_`, `jbs_`, `jbui_`, `jbcr_` token 원문
- pairing challenge, manual code, receipt
- Push endpoint, `p256dh`, auth key, payload
- 알림 본문과 출석 상세값

업무 상태, 결과 건수, HTTP status, 처리 시간과 검증을 마친 비인증용 내부 entity ID는
기록할 수 있습니다.
