# Install one-liner 도입 정리

`curl | sh` / `irm | iex` 한 줄로 Jungle Bell을 설치하는 흐름을 어떻게 설계하고 구현했는지에 대한 회고. 기획 단계의 산출물(`install_distribution_plan_no_homebrew.md` / `install_implementation_plan.md` / `install_checklist.md` / `install_phases.md`)을 정리하면서 의사결정과 결과물만 본 문서에 남긴다.

---

## 1. 동기와 목표

기존 설치 흐름은 사용자가 Releases 페이지에서 `.dmg` / `.exe`를 받아 직접 설치한 뒤, macOS의 경우 `xattr -cr` 같은 추가 명령을 수동으로 실행해야 했다. 진입 장벽이 높고 "손상되었기 때문에 열 수 없습니다" 설치를 어려워하는 것을 반복해서 보았다.

목표:

- macOS / Windows에서 **터미널 한 줄**로 최신 버전 설치 완료
- 기존 `.dmg` / `.exe` 수동 다운로드 경로는 그대로 유지(fallback)
- Tauri updater(`latest.json`, `*.sig`) 동작 영향 없음
- 인프라/운영 부담 최소화

---

## 2. 설계 결정과 근거

| 결정 | 근거 |
|---|---|
| **Homebrew 배포 안 함** | tap 운영 + 버전 sync 부담 대비 이득 작음. 어차피 미서명 앱이라 Cask가 매끄럽지도 않음. |
| **체크섬 검증 안 함** | HTTPS + GitHub Releases 신뢰. 진짜 보안은 코드 서명(추후 과제). 단순화 우선. |
| **자가 기술형(self-describing) 스크립트** | 릴리스마다 워크플로가 `__VERSION__`을 실제 버전으로 치환해 에셋으로 업로드. 사용자가 받은 시점에 어느 버전을 설치할지 결정돼 있어 Worker나 클라이언트 로직이 단순해짐. |
| **macOS는 tar.gz** | `.app` 디렉터리를 그대로 압축. `ditto`로 `/Applications`에 복사하는 방식이 가장 무난. DMG는 수동 다운로드용으로만 유지. |
| **Windows는 NSIS `/S`** | 이미 발급되는 NSIS `.exe`에 silent 플래그를 줘 설치 마법사 없이 끝남. SmartScreen / UAC 팝업은 수용. |
| **Worker는 극단적으로 단순화** | GitHub API 호출 0, 캐시 0, 태그 정규식 0. `releases/latest/download/...`로 redirect만 하고 `?tag=vX.Y.Z` 쿼리로 특정 버전 처리. |
| **README에 버전 하드코딩 안 함** | `?tag=vX.Y.Z` 패턴으로 사용자가 직접 태그를 넣게 해 `bump-version` 스킬이 README를 손댈 필요가 없게 만듦. |
| **ad-hoc 코드 서명 + `xattr -cr`** | Apple Developer ID가 없으므로 `codesign --sign -`로 로컬 검증 가능한 서명만 붙이고, 격리 속성을 제거해 Gatekeeper "손상" 다이얼로그를 회피. |

---

## 3. 아키텍처

### 두 repo의 역할 분담

```text
YangSiJun528/jungle-bell
  install/jungle-bell.sh.tmpl, install/jungle-bell.ps1.tmpl
  src-tauri/tauri.conf.json (bundle targets에 app 명시)
  .github/workflows/release.yml (tar.gz 생성 + 템플릿 치환 업로드)
  README.md (one-liner + ?tag= 안내)

YangSiJun528/install.sijun-yang.com
  Cloudflare Worker — redirect 전용
```

### 공개 URL

| URL | 동작 |
|---|---|
| `https://install.sijun-yang.com/` | 랜딩 페이지 |
| `https://install.sijun-yang.com/jungle-bell.sh` | `releases/latest/download/jungle-bell.sh`로 302 |
| `https://install.sijun-yang.com/jungle-bell.ps1` | 동일 패턴 |
| `https://install.sijun-yang.com/jungle-bell.sh?tag=vX.Y.Z` | `releases/download/vX.Y.Z/jungle-bell.sh`로 302 (stable/prerelease 모두) |
| `https://install.sijun-yang.com/healthz` | 200 헬스 체크 |

### 한 릴리스에 포함되는 에셋

| 파일 | 용도 |
|---|---|
| `Jungle.Bell_<ver>_aarch64.tar.gz` / `_x64.tar.gz` | macOS 자동 설치 스크립트가 받음 (신규) |
| `Jungle.Bell_<ver>_aarch64.dmg` / `_x64.dmg` | macOS 수동 다운로드 |
| `Jungle.Bell_<ver>_x64-setup.exe` | Windows 자동/수동 공용 |
| `jungle-bell.sh` / `jungle-bell.ps1` | 부트스트랩 스크립트 (`__VERSION__` 치환됨, 신규) |
| `Jungle.Bell_<arch>.app.tar.gz` + `.sig`, `latest.json` | Tauri updater (기존) |

---

## 4. 구현 단계

기획 단계에서 8개 Phase로 쪼갰고 실제로는 6개를 진행, 1개는 별도 repo, 1개는 불필요로 종결.

| Phase | 내용 | 결과 | 커밋 |
|---|---|---|---|
| 1 | `src-tauri/tauri.conf.json`의 `bundle.targets`을 `"all"` → `["app", "dmg", "nsis"]`로 명시화 | 로컬 `cargo tauri build`로 `.app` / `.dmg` / updater `.app.tar.gz` 생성 확인 | `d192579` |
| 2 | `install/jungle-bell.sh.tmpl`, `install/jungle-bell.ps1.tmpl` 작성 | sh는 `sh -n` syntax 통과 + `JUNGLE_BELL_ASSET_URL=file://…`로 실 install 경로 검증. ps1은 시뮬레이션 환경 부재로 후속 Windows 실기 검증 보류 | `f7d4559` |
| 3 | `release.yml`에 macOS tar.gz archive step + `publish-installer-scripts` job 추가, `publish-release` `needs` 확장 | YAML lint 통과 | `064b6af` |
| 4 | `v0.2.6-beta.1` prerelease 만들어 워크플로 검증 | 13개 에셋 정상 업로드, 스크립트의 `VERSION="0.2.6-beta.1"` 치환 확인 | `4625529` (bump) + 태그 `v0.2.6-beta.1` |
| 5 | `install.sijun-yang.com` Worker 갱신 | 별도 repo (`YangSiJun528/install.sijun-yang.com`)에서 처리. `?tag=` 쿼리, `/healthz`까지 지원 | — |
| 6a | macOS Apple Silicon에서 직접 GitHub URL로 `curl \| sh` E2E | 정상 설치 + ad-hoc 서명 + xattr clean + `open` 기동 확인 | — |
| 7 | README 설치 섹션 재편 + `?tag=vX.Y.Z` 특정 버전 섹션 추가 | one-liner를 1차 경로로 노출, 수동 다운로드는 fallback | `bec1ca6`, `cca7f92` |
| 8 | `bump-version` 스킬 확장 | `?tag=` 패턴 채택으로 **불필요**. 종결. | — |

전체 커밋 (베이스 `53c50fd` 이후):

```
d192579 chore(release): bundle targets를 명시적 app/dmg/nsis로 고정
f7d4559 feat(installer): macOS/Windows 부트스트랩 설치 스크립트 템플릿 추가
bec1ca6 docs: 설치 섹션을 one-liner 우선 구조로 재편
064b6af ci(release): 설치 스크립트와 macOS tar.gz 에셋을 릴리스에 자동 업로드
4625529 chore(release): bump version to 0.2.6-beta.1
cca7f92 docs: 특정 버전 설치 one-liner 안내 추가
```

---

## 5. 핵심 산출물 요약

### `install/jungle-bell.sh.tmpl`

POSIX `sh`. `uname -m`으로 `arm64` → `aarch64`, `x86_64` → `x64` 매핑. `curl -fL`로 tar.gz 다운로드 → `tar -xzf` → `ditto`로 `/Applications`(쓰기 불가 시 `$HOME/Applications`)에 복사. `codesign --force --deep --sign -` + `xattr -cr` 후처리로 Gatekeeper 차단 회피. `--tag` / `--version` 인자와 `JUNGLE_BELL_ASSET_URL` 환경변수로 로컬 테스트 가능.

### `install/jungle-bell.ps1.tmpl`

PowerShell 5.1+ / Core 양쪽 호환. TLS 1.2 강제, `Invoke-WebRequest -UseBasicParsing`으로 NSIS `.exe` 다운로드 후 `Start-Process -ArgumentList '/S' -Wait -PassThru`로 silent 실행. ExitCode 검사 + `finally` 블록에서 임시 파일 정리.

### `release.yml` 변경 요지

```yaml
publish-tauri:
  steps:
    - tauri-action ...                # 기존 .dmg/.exe 생성
    - Archive .app as tar.gz (macOS)  # 신규
      if: matrix.platform == 'macos-latest'

publish-installer-scripts:           # 신규 job
  needs: [publish-tauri, get-release-info]
  steps:
    - checkout
    - sed s/__VERSION__/.../ install/*.tmpl > out/...
    - gh release upload jungle-bell.sh jungle-bell.ps1

publish-release:
  needs: [publish-tauri, publish-installer-scripts, get-release-info]   # 새 job 추가
```

### Worker 동작

- 모든 GET/HEAD: `redirects.json`의 매핑에 따라 latest 또는 `?tag=` 지정 태그의 GitHub Releases asset URL로 302
- 그 외 path: 404
- 비-GET/HEAD: 405

---

## 6. 검증 결과

### Phase 4 — `v0.2.6-beta.1` prerelease 테스트

- workflow 모든 job 성공 (publish-tauri × 2, publish-installer-scripts, publish-release)
- 에셋 13종 모두 업로드
- `gh release download`로 받은 `jungle-bell.sh`에 `VERSION="0.2.6-beta.1"`, `jungle-bell.ps1`에 `$DefaultVersion = "0.2.6-beta.1"` 치환 확인

### Phase 6a — macOS Apple Silicon E2E

직접 GitHub URL을 사용해 검증 (prerelease는 `releases/latest/`로 잡히지 않으므로 install.sijun-yang.com 경로는 stable 릴리스 후 회귀 확인 예정).

| 검증 | 결과 |
|---|---|
| `curl \| sh` | 정상 완료 |
| `/Applications/Jungle Bell.app` 존재 | OK |
| `codesign -dvv` | `Signature=adhoc`. 의도대로 ad-hoc 서명됨 |
| `xattr` | `com.apple.quarantine` 없음 |
| `spctl --assess` | rejected — Apple Developer ID 없는 ad-hoc 서명에 대한 정상 결과. quarantine이 없어 실제 차단으로 이어지지는 않음 |
| `open` 으로 기동 | 정상 (단, 단일 인스턴스 락 때문에 두 번째 `open`은 즉시 종료) |

### 보류

- **Intel Mac**: 실기기 없음 → best-effort. 베타 사용자 리포트로 보강.
- **Windows E2E**: 실기기 없음 → 베타 사용자 리포트 또는 다음 워크스테이션에서 검증.
- **install.sijun-yang.com latest 회귀**: 다음 stable 릴리스 시점에 `curl -fsSL https://install.sijun-yang.com/jungle-bell.sh | sh`가 끝까지 동작하는지 1회 확인 필요 (현재는 v0.2.5가 latest로 잡혀 있어 새 스크립트가 없음 → 404).

---

## 7. 운영 노트

- 다음 stable 릴리스(예: `v0.2.6`) 직후 한 번:
  - `curl -I https://install.sijun-yang.com/jungle-bell.sh` 가 302로 새 스크립트로 가는지
  - `curl -fsSL .../jungle-bell.sh | sh`로 끝까지 설치되는지
- README는 버전과 무관하므로 릴리스마다 손댈 일 없음.
- SmartScreen / Apple Developer ID 코드 서명 도입은 별도 과제. 비용/유지보수 부담이 커서 베타 사용자 수가 더 늘어난 뒤에 재검토.
