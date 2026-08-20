<p></p>
<img src="docs/assets/readme/logo.png" height="100" alt="Jungle Bell" align="left"/>

<div>
<h3>Jungle Bell</h3>
<p>PC 앱이 Jungle Campus 출석 상태를 주기적으로 확인하고 서버에 동기화해요.<br>PC와 설치형 모바일 PWA에서 출석·세탁·급식 정보와 알림을 함께 볼 수 있어요.</p>
</div>

<br/>

<div align="center">
    <a href="https://github.com/YangSiJun528/jungle-bell/releases"><img src="https://img.shields.io/github/v/release/YangSiJun528/jungle-bell?include_prereleases" alt="GitHub Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/YangSiJun528/jungle-bell" alt="License"></a>
    <a href="https://github.com/YangSiJun528/jungle-bell"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platform"></a>
</div>

<hr>

> [!CAUTION]  
> Jungle Bell은 크래프톤 정글 공식 앱이 아니며, 자동 출석 기능을 제공하지 않습니다.

## 설치

웹과 설치형 PWA는 [jungle-bell.sijun-yang.com](https://jungle-bell.sijun-yang.com)에서
사용할 수 있습니다.

수동 설치를 원하는 경우 [Release 페이지](https://github.com/YangSiJun528/jungle-bell/releases/latest)를 참고하세요.

### macOS

아래 명령어를 터미널에서 실행해 Jungle Bell을 설치하세요.

```bash
curl -fsSL https://install.sijun-yang.com/jungle-bell.sh/latest | sh
```

### Windows

아래 명령어를 PowerShell에서 실행해 Jungle Bell을 설치하세요.

```powershell
irm https://install.sijun-yang.com/jungle-bell.ps1/latest | iex
```

### AI 에이전트에게 맡기기

Codex나 Claude Code처럼 컴퓨터 명령을 대신 실행할 수 있는 AI 에이전트에게 아래 문장을 보내세요.

```text
이 컴퓨터에 Jungle Bell 최신 안정 릴리스를 설치해 줘: https://github.com/YangSiJun528/jungle-bell
README의 설치 섹션에서 운영체제에 맞는 자동 설치 명령을 사용해.
```

> 에이전트 환경에 따라 명령 실행과 다운로드 권한을 직접 승인해야 할 수 있어요.

## 동작 방식

- PC 앱만 Jungle Campus에 로그인하고 약 5분마다 출석 상태를 확인합니다.
- LMS cookie와 token은 PC 앱의 전용 WebView 밖으로 보내거나 서버에 저장하지 않습니다.
- 서버에는 정규화한 출석 상태와 Jungle Bell 전용 기기 session만 저장합니다.
- 설치형 PWA는 LMS를 직접 조회하지 않습니다. PC가 마지막으로 동기화한 상태를 읽고 Web Push를 받습니다.
- 일반 웹에서는 공개 급식·세탁 정보만 볼 수 있습니다. 출석 확인과 개인 알림은 PC 앱 또는 설치형 PWA에서만 제공합니다.

PC 앱이 종료되거나 컴퓨터가 잠자기 상태면 출석 정보가 갱신되지 않습니다. 서버가 오래된 상태를 최신 상태로 추측하지 않으며, 필요한 경우 상태를 확인할 수 없다는 알림을 보냅니다.

## 사용 기록과 개인정보

Jungle Bell은 PostHog나 Google Analytics를 사용하지 않습니다. 일반 웹·PWA의 일별
방문과 연결된 사용자·기능의 최소 사용량만 자체 서버에서 집계하며 입력 내용과 LMS
계정 정보는 사용 통계에 넣지 않습니다. 수집 항목과 보존기간은
[개인정보 처리 안내](https://jungle-bell.sijun-yang.com/#/privacy)에서 확인할 수 있습니다.

## 처음 연결하기

PC 화면의 QR은 설치 파일이나 인증 전용 QR이 아니라 **휴대폰 설정을 시작하는 링크**입니다.
한 번 스캔하면 PC 연결, 앱 설치, 선택형 알림 확인을 한 흐름에서 안내합니다.

1. PC 앱을 실행하고 대시보드에서 **공식 정글캠퍼스 열기**를 눌러 로그인합니다.
2. **설정 → 기기 연결**에서 **휴대폰 설정 QR 만들기**를 누릅니다.
3. 휴대폰 카메라로 QR을 스캔합니다. QR을 쓰기 어렵다면 휴대폰에서
   `https://jungle-bell.sijun-yang.com/#/setup`을 열고 PC의 10자리 연결 코드를 입력합니다.
4. 휴대폰에 표시된 4자리 확인 번호와 기기명을 PC에서 대조한 뒤 **이 휴대폰 승인**을 누릅니다.
5. 연결이 끝나면 iPhone은 **홈 화면에 추가**, Android는 **앱 설치**를 선택하고 홈 화면 아이콘으로 실행합니다.
6. 표시되는 **알림 확인 (선택)**에서 테스트하거나 **나중에**를 누릅니다. 건너뛰어도 앱 사용에는 영향이 없으며 알림 센터에서 다시 테스트할 수 있습니다.

연결 코드와 QR은 2분 동안만 유효합니다. QR의 일회용 값은 주소 표시줄에서 즉시
제거되고 브라우저 저장소에 남지 않습니다. 모바일 session은 연결 후 최대 30일
유지되며 PC 앱에서 언제든 해제할 수 있습니다. 브라우저 데이터 삭제, 운영체제의
저장소 정리 또는 PC identity 초기화가 발생하면 다시 연결해야 합니다.

설치 뒤 PWA에 연결 화면이 다시 나타나면 PC에서 새 QR과 코드를 만들고, 설치한 PWA
안에서 10자리 코드를 입력해 다시 연결하세요.

## 출석 상태 보기

출석 상태는 메뉴 바(macOS) 또는 작업 표시줄(Windows)에 있는 Jungle Bell 아이콘으로 표시돼요. 둥근 상태색 배경과 투명한 나침반 형태를 사용하고, 시스템의 밝은·어두운 테마에 맞는 자산으로 자동 전환합니다.

<table>
  <tr>
    <td align="center" width="58">
      <img src="docs/assets/readme/readme-status-offline.svg" width="52" alt="회색 상태 아이콘">
    </td>
    <td><strong>상태 확인 중 / 확인 불가</strong><br>로그인 세션이나 네트워크 상태를 다시 확인하고 있어요.</td>
  </tr>
  <tr>
    <td align="center" width="58">
      <img src="docs/assets/readme/readme-status-alert.svg" width="52" alt="빨간 상태 아이콘">
    </td>
    <td><strong>출석 시작/종료 가능</strong><br>출석 페이지를 열어 체크인/체크아웃해 주세요.</td>
  </tr>
  <tr>
    <td align="center" width="58">
      <img src="docs/assets/readme/readme-status-normal.svg" width="52" alt="흰색 또는 검은색 학습 중 상태 아이콘">
    </td>
    <td><strong>학습 중 / 별도 조작 없음</strong><br>현재 출석이 정상적으로 진행 중이며 지금 처리할 작업은 없어요.</td>
  </tr>
  <tr>
    <td align="center" width="58">
      <img src="docs/assets/readme/readme-status-complete.svg" width="52" alt="흰색 또는 검은색 출석 완료 상태 아이콘">
    </td>
    <td><strong>출석 완료</strong><br>밝은 배경에서는 짙은 선, 어두운 배경에서는 밝은 선으로 낮게 표시돼요.</td>
  </tr>
  <tr>
    <td align="center" width="58">
      <img src="docs/assets/readme/readme-status-warning.svg" width="52" alt="주황 상태 아이콘">
    </td>
    <td><strong>로그인 필요</strong><br>Jungle Campus에 로그인해 주세요.</td>
  </tr>
</table>

## 생활 정보 보기

대시보드의 **세탁**에서는 세탁기와 건조기의 사용 가능 여부, 남은 시간, 예상 종료 시각을 확인할 수 있습니다. `추정` 표시는 마지막 LG ThinQ 관측값을 기준으로 계산한 값이며, 0분이 되어도 완료 상태가 확인되기 전에는 **완료 확인 중**으로 표시됩니다.

**오늘의 식단**에서는 당일 중식과 석식, 고정된 주간 식단표, 최근 식단을 확인할 수 있습니다. 네트워크나 수집이 일시적으로 실패하면 앱에 마지막으로 저장된 정보를 표시합니다.

PC 앱과 연결된 PWA에서는 출석 시간대, 급식 종류, 특정 세탁기의 종료·사용 가능 알림을 설정할 수 있습니다.

## 인증 정보 보관

Jungle Bell은 OS keychain을 사용하지 않습니다. PC용 Jungle Bell credential은 앱 전용 데이터 폴더의 접근 제한 파일에 저장하고 서버에는 hash만 보관합니다. credential의 절대 만료 기간은 90일이며 PC 앱이 실행 중이면 만료 전에 자동 교체합니다. 만료된 뒤에는 새 PC identity를 만들고 PWA를 다시 연결해야 합니다.

모바일 인증은 `HttpOnly`, `Secure`, `SameSite=Strict` cookie로 저장합니다. JavaScript나 서비스 워커는 인증 token 원문을 읽지 않습니다.

## 문제가 생겼나요?

#### 아이콘이 안 보여요.

macOS는 메뉴 바 오른쪽을 확인해 주세요.

Windows는 작업 표시줄 오른쪽을 확인해 주세요. 처음에는 숨겨진 아이콘 메뉴(`∧`)에 있을 수 있어요.

#### 로그인이 필요하다고 떠요.

PC 대시보드에서 **공식 정글캠퍼스 열기**를 눌러 Jungle Campus에 로그인해 주세요. PWA만으로는 LMS 로그인을 복구하거나 출석 상태를 갱신할 수 없습니다.

#### 알림이 오지 않아요.

PC는 **알림 확인 (선택)** 또는 알림 센터의 **테스트 알림**을 실행한 뒤, 실패 안내의
**알림 설정 열기**에서 운영체제 권한을 확인해 주세요. PWA는 홈 화면 아이콘으로
실행했는지와 PC 연결 상태를 확인하고 **알림 연결하고 테스트**를 다시 누르세요.
서버가 전송을 접수해도 실제 표시까지 최대 1분 정도 걸릴 수 있습니다.

**테스트 알림**은 하나의 알림 event를 현재 PC와 연결된 모든 활성 PWA 대상으로
생성합니다. PC 알림함은 다음 poll에서, PWA Push는 서버 background scheduler가
전달합니다.

#### 설치 중 경고가 떠요.

자동 설치 명령을 사용하는 것을 권장합니다.  
직접 다운로드 방법과 문제 해결은 [Release 페이지](https://github.com/YangSiJun528/jungle-bell/releases/latest)의 안내를 확인해 주세요.

#### 출석 상태가 실제와 달라요.

PC 대시보드에서 **새로고침**을 누른 뒤 Jungle Campus 로그인 상태를 확인해 주세요. 계속 다르면 [문의](#질문제보하기)해 주세요.

## 질문·제보하기

- [버그 제보](https://github.com/YangSiJun528/jungle-bell/issues/new?template=bug.yml)
- [기능 개선 건의](https://github.com/YangSiJun528/jungle-bell/issues/new?template=feature_request.yml)
- [질문](https://github.com/YangSiJun528/jungle-bell/issues/new?template=question.yml)

이슈를 작성할 때는 사용 중인 OS, 재현 조건, 가능하면 스크린샷을 함께 보내 주세요.

## 개발 구조

- `server/`: Spring Core·API·Worker 멀티모듈
- `frontend/`: 공통 Vite·React SPA와 Web·PWA·Tauri 어댑터
- `desktop/`: Tauri Rust 런타임과 capability·bundle 설정

프론트엔드 명령은 `frontend/`, Gradle 명령은 `server/`, Cargo 명령은
`desktop/`을 기준으로 실행합니다. 웹과 데스크톱은 같은 React 화면을 사용하며,
웹 빌드는 `frontend/dist/web`, Tauri UI 빌드는 `frontend/dist/desktop`에 생성됩니다.

```bash
cd frontend
npm ci
npm run dev:web          # 브라우저·PWA
export JUNGLE_BELL_DATA_API_URL=https://jungle-bell.sijun-yang.com
npm run desktop:dev      # 같은 SPA + Tauri 어댑터

cd ../server
./gradlew check :api:bootJar :worker:bootJar
```

## 주의사항

#### 비공식 앱

Jungle Bell은 크래프톤 정글 공식 앱이 아닙니다.  
SW-AI Lab 12기인 한 정글러가 관리하는 비공식 앱입니다.

#### 자동 출석 미지원

자동 출석 기능은 제공하지 않으며, 앞으로도 제공할 계획이 없습니다.  
출석은 Jungle Campus 출석 페이지에서 직접 진행해야 합니다.

#### 문의

새 기능·보완 요청, 질문, 재현 가능한 버그는 모두 [GitHub Issues](https://github.com/YangSiJun528/jungle-bell/issues/new/choose)의 해당 양식을 사용합니다.

## 라이선스

[Apache License 2.0](LICENSE)
