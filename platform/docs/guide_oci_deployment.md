# 단일 OCI VM에 배포하기

이 가이드는 Jungle Bell을 OCI Linux VM 한 대에 배포하는 절차입니다.
Caddy는 host에서 실행하고, Fastify·React는 Docker container 하나와
Node.js process 하나로 실행합니다. SQLite는 VM 로컬 영속 volume에
둡니다.

## 준비 사항

- 고정 public IP가 있는 OCI VM
- VM의 로컬 persistent boot 또는 block volume
- VM을 가리키는 DNS A/AAAA record
- OCI security rule과 host firewall의 TCP 80·443 ingress
- Docker Engine과 Docker Compose
- host systemd로 실행하는 Caddy
- 배포할 repository revision
- VAPID 연락처로 사용할 `mailto:` 주소

포트 8787은 외부에 열지 않습니다. SQLite directory를 NFS, object
storage mount, 여러 VM이 공유하는 volume에 두지 않습니다.

아래 명령은 repository가 `/opt/jungle-bell`에 있고 VM의 container
사용자 UID/GID가 1000이라고 가정합니다. base image를 바꾸면 실제
UID/GID를 먼저 확인하십시오.

## 1. 배포 전 자동 검증을 실행합니다

개발 또는 CI 환경의 `platform/`에서 실행합니다.

```bash
npm ci
npm run verify
npm run smoke:platform
npm run smoke:load
npm run smoke:campus-live
npm run smoke:container
```

`smoke:load`에는 k6, `smoke:container`에는 Docker가 필요합니다. 실제
Google SSO·2단계 인증과 실제 Web Push 전달은 이 명령에 포함되지
않습니다.

## 2. 영속 directory를 만듭니다

```bash
sudo install -d -o 1000 -g 1000 -m 0700 /srv/jungle-bell/data
sudo install -d -o root -g root -m 0700 /srv/jungle-bell/secrets
sudo install -d -o root -g root -m 0700 /etc/jungle-bell
```

`/srv/jungle-bell/data`에는 SQLite DB, WAL sidecar, online backup이
생성됩니다. secret은 이 directory에 넣지 않습니다.

## 3. 서버 secret을 만듭니다

Pairing transport와 LMS identity HMAC에 서로 다른 32바이트 random key를
사용합니다.

```bash
openssl rand -base64 32 | sudo tee \
  /srv/jungle-bell/secrets/session-encryption-key >/dev/null
openssl rand -base64 32 | sudo tee \
  /srv/jungle-bell/secrets/identity-hmac-key >/dev/null
sudo chown root:1000 \
  /srv/jungle-bell/secrets/session-encryption-key \
  /srv/jungle-bell/secrets/identity-hmac-key
sudo chmod 0440 \
  /srv/jungle-bell/secrets/session-encryption-key \
  /srv/jungle-bell/secrets/identity-hmac-key
```

`session-encryption-key`는 2분짜리 승인된 모바일 session handoff를
암호화합니다. LMS cookie를 암호화해 보관하는 key가 아닙니다.

`identity-hmac-key`는 immutable LMS ID를 기존 내부 사용자와 연결하는
핵심 복구 자산입니다. 이 key를 잃거나 다른 값으로 바꾸면 이후 같은 LMS
계정을 기존 사용자로 식별할 수 없습니다.

두 key 모두 DB와 다른 접근 통제 영역에 off-host backup하십시오. secret
값을 repository, Compose environment, shell history, 지원 로그에 넣지
마십시오.

## 4. VAPID key pair를 만듭니다

관리 workstation의 `platform/`에서 한 번 실행합니다.

```bash
npm ci
npx web-push generate-vapid-keys
```

public key는 다음 단계의 environment file에 기록합니다. private key는
다음 파일에 값만 저장하고 접근 권한을 제한합니다.

```text
/srv/jungle-bell/secrets/vapid-private-key
```

```bash
sudoedit /srv/jungle-bell/secrets/vapid-private-key
sudo chown root:1000 /srv/jungle-bell/secrets/vapid-private-key
sudo chmod 0440 /srv/jungle-bell/secrets/vapid-private-key
```

VAPID private key도 off-host backup에 포함합니다. key pair를 바꾸면 기존
browser subscription을 다시 등록해야 할 수 있습니다.

## 5. Compose environment를 작성합니다

```bash
sudo install -o root -g root -m 0600 \
  /opt/jungle-bell/platform/.env.oci.example \
  /etc/jungle-bell/platform.env
sudoedit /etc/jungle-bell/platform.env
```

예제의 다음 값을 실제 값으로 바꿉니다.

```dotenv
JB_DOMAIN=bell.example.com
JB_PUBLIC_ORIGIN=https://bell.example.com
JB_DATA_DIRECTORY=/srv/jungle-bell/data
JB_SESSION_ENCRYPTION_KEY_PATH=/srv/jungle-bell/secrets/session-encryption-key
JB_IDENTITY_HMAC_KEY_PATH=/srv/jungle-bell/secrets/identity-hmac-key
JB_CAMPUS_DATA_API_URL=https://jungle-bell-api.yangsijun5528.workers.dev
JB_VAPID_SUBJECT=mailto:operator@example.com
JB_VAPID_PUBLIC_KEY=PASTE_PUBLIC_VAPID_KEY
JB_VAPID_PRIVATE_KEY_PATH=/srv/jungle-bell/secrets/vapid-private-key
JB_BACKUP_RETENTION_DAYS=30
JB_MIN_FREE_DISK_BYTES=134217728
JB_CONTAINER_CPUS=4
JB_CONTAINER_MEMORY=2g
```

`JB_PUBLIC_ORIGIN`은 path나 trailing slash가 없는 실제 외부 HTTPS
origin이어야 합니다. Compose는 host의 `127.0.0.1:8787`에만 port를
publish하고 Caddy 한 홉을 신뢰합니다.

`JB_BACKUP_RETENTION_DAYS`는 로컬 online backup 보존 기간입니다. 기본값은
30일이며 1–3650 사이의 정수만 허용됩니다. 빈 값, 0, 소수, 범위를 벗어난
값이면 backup 명령은 파일을 만들거나 지우기 전에 실패합니다.

`JB_MIN_FREE_DISK_BYTES`는 readiness가 요구하는 DB filesystem의 최소
여유 공간입니다. 기본값은 128 MiB입니다. 운영 volume 크기와 경보 정책에
맞춰 더 크게 설정할 수 있습니다.

현재 OCI VM이 12 OCPU·8 GB여도 container 기본 제한은 4 CPU·2 GB입니다.
부하 smoke와 운영 metric을 확인한 뒤 두 제한만 조정하십시오. Node.js
application process를 여러 개로 늘리면 안 됩니다.

## 6. container를 시작합니다

```bash
cd /opt/jungle-bell/platform
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  config
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  up -d --build
```

container는 read-only root filesystem, non-root `node` user, dropped
capabilities, `no-new-privileges`, 별도 writable data mount로
실행됩니다.

```bash
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  ps
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  top
curl --fail --silent --show-error \
  http://127.0.0.1:8787/api/health
curl --fail --silent --show-error \
  http://127.0.0.1:8787/api/ready
```

`top`에는 container init 외에 `node apps/api/dist/server.js`가 하나만
있어야 합니다. Node cluster, Compose scale, 두 번째 app container를
추가하지 않습니다.

시작에 실패하면 secret의 owner·mode와 data directory 쓰기 권한을
확인합니다. secret 내용을 출력하지 않습니다.

```bash
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  exec platform \
  sh -c 'id && test -r /run/secrets/session_encryption_key && test -r /run/secrets/identity_hmac_key && test -r /run/secrets/vapid_private_key'
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  logs --tail=100 platform
```

## 7. Caddy HTTPS를 연결합니다

예제 파일을 복사하고 첫 site label을 실제 hostname으로 바꿉니다.
systemd Caddy가 `/etc/jungle-bell/platform.env`를 자동으로 읽는다고
가정하지 마십시오.

```bash
sudo install -m 0644 \
  /opt/jungle-bell/platform/Caddyfile.oci.example \
  /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

예제의 `{$JB_DOMAIN}`을 다음처럼 바꿉니다.

```caddyfile
bell.example.com {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), geolocation=(), microphone=()"
	}

	reverse_proxy 127.0.0.1:8787
}
```

실제 파일의 보안 header block은 유지하십시오. HTML과 API는 서로 다른
CSP가 필요하므로 Caddy가 애플리케이션 CSP를 덮어쓰지 않습니다.

```bash
curl --fail --silent --show-error \
  https://bell.example.com/api/health
curl --fail --silent --show-error \
  https://bell.example.com/api/ready
curl --fail --silent --show-error \
  https://bell.example.com/api/ready
curl --head https://bell.example.com/
curl --head https://bell.example.com/api/health
```

외부 응답에서 HSTS, `nosniff`, referrer·permissions policy와 경로별
CSP를 확인합니다. health는 process liveness만 검사합니다. ready는
SQLite query와 DB filesystem의 최소 여유 공간을 검사하지만 campus
upstream이나 Push provider의 상태는 readiness에서 제외합니다.

## 8. Tauri production artifact를 만듭니다

배포한 HTTPS origin을 build에 고정합니다.

```bash
cd /opt/jungle-bell/platform
JB_APP_ORIGIN=https://bell.example.com \
JB_API_ORIGIN=https://bell.example.com \
npm run tauri:build
```

release build는 runtime 환경 변수로 origin을 바꾸지 않습니다. 배포
domain을 변경하면 데스크톱 artifact도 다시 build·배포해야 합니다.

## 9. SQLite online backup을 만듭니다

실행 중인 DB나 `-wal`, `-shm` 파일을 `cp`로 복사하지 않습니다. runtime
image 안의 build된 backup entrypoint를 실행합니다.

```bash
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f /opt/jungle-bell/platform/docker-compose.oci.yml \
  exec -T \
  -e JB_BACKUP_DIRECTORY=/app/data/backups \
  -e JB_BACKUP_RETENTION_DAYS=30 \
  platform \
  node apps/api/dist/backup.js
```

출력된 `/srv/jungle-bell/data/backups/*.sqlite`는 생성 직후
`integrity_check`와 `foreign_key_check`를 모두 통과한 mode `0600`
snapshot입니다. 검사가 하나라도 실패하면 명령도 실패합니다.

검사가 끝난 뒤 설정한 기간보다 오래된 로컬 snapshot을 정리합니다. 정확히
`jungle-bell-YYYYMMDDTHHMMSSZ.sqlite` 형식인 일반 단일-link 파일만
대상입니다. 원본 DB와 같은 inode, symbolic link, hard link, directory,
다른 이름의 파일은 삭제하지 않습니다. 이 로컬 retention은 off-host
backup을 대신하지 않습니다.

repository checkout에서 같은 작업을 실행할 때의 package script는
다음과 같습니다.

```bash
npm run build -w @jungle-bell/api
JB_DB_PATH="$PWD/.data/jungle-bell.sqlite" \
JB_BACKUP_DIRECTORY="$PWD/.data/backups" \
JB_BACKUP_RETENTION_DAYS=30 \
npm run db:backup -w @jungle-bell/api
```

## 10. 정기 backup을 설정합니다

다음 systemd service는 매일 SQLite online backup을 실행하는 예입니다.

```ini
# /etc/systemd/system/jungle-bell-backup.service
[Unit]
Description=Jungle Bell SQLite online backup
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/jungle-bell/platform
ExecStart=/usr/bin/docker compose --env-file /etc/jungle-bell/platform.env -f /opt/jungle-bell/platform/docker-compose.oci.yml exec -T -e JB_BACKUP_DIRECTORY=/app/data/backups -e JB_BACKUP_RETENTION_DAYS=30 platform node apps/api/dist/backup.js
```

```ini
# /etc/systemd/system/jungle-bell-backup.timer
[Unit]
Description=Run Jungle Bell backup daily

[Timer]
OnCalendar=*-*-* 03:30:00 Asia/Seoul
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jungle-bell-backup.timer
sudo systemctl start jungle-bell-backup.service
sudo systemctl status jungle-bell-backup.service
sudo systemctl list-timers jungle-bell-backup.timer
```

이 timer는 안전한 로컬 retention까지만 실행합니다. off-host 전송 실패
경보와 원격 저장소 접근 통제는 다음 단계에서 별도로 설정합니다.

## 11. restic으로 off-host backup을 전송합니다

[restic](https://restic.net/)은 유지보수되는 오픈소스 backup
도구이며 snapshot 암호화, 여러 원격 backend, 보존 정책, 무결성 검사를
제공합니다. backend별 설정은
[공식 repository 준비 문서](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)를
따릅니다.

repository 위치, repository 암호, object storage나 SFTP 인증 정보는
이 repository나 systemd unit에 기록하지 마십시오. 운영 환경의 root 전용
credential file 또는 secret manager에서 restic process에 전달합니다.
아래 예시는 운영자가 별도로 만든 root 전용 repository·password file을
참조하며, 외부 provider 계정이나 credential을 만들지 않습니다.

로컬 backup service가 성공한 뒤 다음 순서로 DB snapshot과 세 server
secret을 전송합니다.

```bash
sudo restic \
  --repository-file /etc/jungle-bell/restic-repository \
  --password-file /etc/jungle-bell/restic-password \
  backup \
  /srv/jungle-bell/data/backups \
  /srv/jungle-bell/secrets \
  --tag jungle-bell
sudo restic \
  --repository-file /etc/jungle-bell/restic-repository \
  --password-file /etc/jungle-bell/restic-password \
  forget \
  --tag jungle-bell \
  --keep-daily 14 \
  --keep-weekly 8 \
  --keep-monthly 12 \
  --prune
sudo restic \
  --repository-file /etc/jungle-bell/restic-repository \
  --password-file /etc/jungle-bell/restic-password \
  check
```

처음 적용할 때는 `forget`에 `--dry-run`을 붙여 삭제 대상을 검토합니다.
`prune`은 repository를 잠그고 시간이 걸릴 수 있으므로 local backup과
겹치지 않게 실행합니다. 보존 정책과 `check` 동작은
[공식 retention 문서](https://restic.readthedocs.io/en/stable/060_forget.html)와
[공식 무결성 검사 문서](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)를
기준으로 관리합니다.

자동화할 때는 local backup의 성공 이후에만 restic을 실행하고 각 명령의
non-zero exit를 monitoring으로 전달합니다. VM 로컬 snapshot이 30일
남아 있더라도 restic 실패를 성공으로 취급하지 않습니다. restic
repository 암호도 DB와 다른 위치에 복구 가능하게 보관해야 합니다.

## 12. 격리된 restore drill을 실행합니다

최근 off-host snapshot을 격리 directory로 복원합니다. repository와
credential은 backup 때와 같은 out-of-band 방식으로 전달합니다.

```bash
sudo install -d -o root -g root -m 0700 \
  /srv/jungle-bell/restic-restore-drill
sudo restic \
  --repository-file /etc/jungle-bell/restic-repository \
  --password-file /etc/jungle-bell/restic-password \
  snapshots --tag jungle-bell
sudo restic \
  --repository-file /etc/jungle-bell/restic-repository \
  --password-file /etc/jungle-bell/restic-password \
  restore latest \
  --tag jungle-bell \
  --target /srv/jungle-bell/restic-restore-drill
```

복원된 tree에서 검사할 `jungle-bell-YYYYMMDDTHHMMSSZ.sqlite` 하나를
선택합니다. 운영 DB를 덮어쓰지 않고 snapshot이 열리는지 확인합니다.

```bash
sudo install -d -o 1000 -g 1000 -m 0700 \
  /srv/jungle-bell/restore-drill
sudo install -o 1000 -g 1000 -m 0600 \
  /srv/jungle-bell/restic-restore-drill/srv/jungle-bell/data/backups/jungle-bell-SELECTED.sqlite \
  /srv/jungle-bell/restore-drill/jungle-bell.sqlite
```

현재 image로 SQLite integrity, foreign key, schema version을
side-effect 없이 검사합니다. app server와 worker를 시작하지 않으므로
실제 사용자에게 알림을 보내지 않습니다.

```bash
sudo docker run --rm \
  --volume /srv/jungle-bell/restore-drill:/restore \
  jungle-bell-platform:local \
  node -e "const D=require('better-sqlite3');const db=new D('/restore/jungle-bell.sqlite',{readonly:true,fileMustExist:true});const integrity=db.pragma('integrity_check',{simple:true});const foreignKeys=db.pragma('foreign_key_check');const version=db.pragma('user_version',{simple:true});console.log({integrity,foreignKeyViolations:foreignKeys.length,userVersion:version});db.close();if(integrity!=='ok'||foreignKeys.length)process.exit(1)"
```

그다음 격리된 VM 또는 outbound network가 차단된 복구 환경에서 같은
snapshot과 세 secret을 복원하고 현재 Compose revision을 시작하십시오.
다음을 확인해야 restore drill이 완료됩니다.

- container가 현재 schema로 시작하고 health 200을 반환함
- 사용자·desktop·mobile session·출석·규칙의 비민감 count가 예상 범위임
- identity HMAC key와 pairing transport·VAPID key 파일이 같은 권한으로
  복구되고 container에서 읽을 수 있음
- 실제 사용자 Push endpoint로 outbound 요청이 나가지 않음

같은 LMS 계정이 기존 사용자에 다시 연결되는지는 복구본을 운영으로
승격한 뒤 권한 있는 실계정 한 개로 확인합니다. 격리 drill에서 실제
Google SSO나 LMS 요청을 자동화하지 않습니다.

운영 VM에서 복구해야 할 때는 먼저 app container를 중지하고 기존 data
directory 전체를 별도 보존한 뒤, 검증한 snapshot을
`jungle-bell.sqlite`로 설치하고 app을 시작합니다. 실행 중인 DB 위에
snapshot을 덮어쓰거나 이전 `-wal`, `-shm`을 새 DB와 섞지 마십시오.

## 13. revision을 갱신합니다

업데이트 직전에 online backup과 off-host 전송을 완료합니다.

```bash
cd /opt/jungle-bell/platform
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  build --pull platform
sudo docker compose \
  --env-file /etc/jungle-bell/platform.env \
  -f docker-compose.oci.yml \
  up -d --no-deps platform
curl --fail --silent --show-error \
  https://bell.example.com/api/health
```

SQLite migration은 시작 시 앞으로만 적용됩니다. 이 개편은 과거
`lms_sessions`·server collector schema를 의도적으로 거부합니다. 새
schema를 읽지 못하는 이전 image로 단순 rollback하지 말고, upgrade 전
snapshot과 해당 revision을 함께 복구하십시오.

## 14. 운영 수동 smoke를 완료합니다

배포 뒤 실제 계정 한 개와 실제 휴대폰 한 개로 확인합니다.

1. Tauri에서 Google SSO·2단계 인증과 첫 출석 snapshot
   (active 기수 기간에는 오전·오후 `/attendance/today` 값까지 확인)
2. Tauri 재시작 뒤 LMS subject 재검증과 snapshot 갱신
3. 설치된 PWA 안에서 10자리 코드로 연결
4. PC에서 mobile session 목록 확인·해제, 모바일 self logout
5. 실제 모바일 Web Push test와 알림 클릭의 same-origin `/app` 이동
6. 실제 desktop 네이티브 알림과 ack
7. 공개 급식·세탁의 last-updated·stale 표시

Google SSO·2단계 인증과 실제 Apple·Google Push는 자동 검증 결과가
아니므로 실행 시각·기기·OS·통과 여부를 별도 기록합니다.

## 배포 완료 조건

- public 80·443만 열리고 8787은 loopback에만 bind됨
- app container와 Node.js application process가 각각 하나임
- 내부·외부 `/api/health`와 `/api/ready`가 200임
- Caddy와 애플리케이션 보안 header가 외부 응답에 있음
- SQLite와 WAL이 `/srv/jungle-bell/data`에 있음
- LMS credential table이 없고 LMS cookie가 서버 log에 없음
- campus collector와 notification outbox worker가 단일 process에서
  실행됨
- online backup이 off-host로 전송되고 최근 restore drill이 통과함
- identity, pairing transport, VAPID secret이 DB·environment file과
  분리됨
- 실계정 LMS와 실제 Web Push 수동 smoke가 기록됨
