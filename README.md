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

## 처음 연결하기

1. PC 앱을 실행하고 대시보드에서 **공식 정글캠퍼스 열기**를 눌러 로그인합니다.
2. 대시보드의 **PC 연결**에서 10자리 연결 코드 또는 QR을 만듭니다.
3. 휴대폰 브라우저에서 Jungle Bell 대시보드를 연 뒤 **홈 화면에 추가** 또는 **앱 설치**를 선택합니다.
4. 설치한 PWA를 실행해 연결 코드를 입력하고 PC 앱에서 표시된 기기를 승인합니다.
5. PWA에서 알림 권한을 허용합니다.

연결 코드는 2분 동안만 유효합니다. 모바일 session은 연결 후 최대 365일 유지되며 PC 앱에서 언제든 해제할 수 있습니다. 브라우저 데이터 삭제, 운영체제의 저장소 정리 또는 PC identity 초기화가 발생하면 다시 연결해야 합니다.

## 출석 상태 보기

출석 상태는 메뉴 바(macOS) 또는 작업 표시줄(Windows)에 있는 Jungle Bell 아이콘으로 표시돼요. 원본 나침반과 얇은 테두리를 유지하면서, 확인이나 조작이 필요할 때만 상태색을 사용합니다.

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

PC 앱과 연결된 PWA에서는 출석 시간대, 급식 종류, 특정 세탁기의 종료·사용 가능 알림을 설정할 수 있습니다. 세탁 **자율 대기열**은 실제 LG 예약이나 기기 제어 기능이 아닙니다. 관측상 기기가 사용 가능해지면 내부 FIFO 순서대로 5분간 차례를 알려 주는 보조 기능이며 실제 우선권을 보장하지 않습니다.

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

PC는 운영체제 알림 권한과 대시보드의 개인 알림 설정을 확인해 주세요. PWA는 설치형으로 실행했는지, PC와 연결되어 있는지, 브라우저 알림 권한과 Push 구독이 활성화되어 있는지 확인해 주세요.

대시보드의 **테스트 알림 보내기**는 하나의 알림 event를 현재 PC와 연결된 모든 활성 PWA 대상으로 생성합니다. PC inbox는 다음 poll에서, PWA Push는 보통 다음 1분 Jobs 실행에서 전달됩니다.

#### 설치 중 경고가 떠요.

자동 설치 명령을 사용하는 것을 권장합니다.  
직접 다운로드 방법과 문제 해결은 [Release 페이지](https://github.com/YangSiJun528/jungle-bell/releases/latest)의 안내를 확인해 주세요.

#### 출석 상태가 실제와 달라요.

PC 대시보드에서 **지금 동기화**를 누른 뒤 Jungle Campus 로그인 상태를 확인해 주세요. 계속 다르면 [문의](#질문제보하기)해 주세요.

## 질문·제보하기

- [공식 소식](https://jungle-bell-api.yangsijun5528.workers.dev/blog/index.html): 업데이트와 이용 안내
- GitHub Discussions: [건의하기](https://github.com/YangSiJun528/jungle-bell/discussions/categories/건의하기), [궁금해요](https://github.com/YangSiJun528/jungle-bell/discussions/categories/궁금해요)
- [GitHub Issues](https://github.com/YangSiJun528/jungle-bell/issues/new?template=bug.yml): 재현 가능한 버그 제보

버그를 제보할 때는 사용 중인 OS, 재현 조건, 가능하면 스크린샷을 함께 보내 주세요.

## 주의사항

#### 비공식 앱

Jungle Bell은 크래프톤 정글 공식 앱이 아닙니다.  
SW-AI Lab 12기인 한 정글러가 관리하는 비공식 앱입니다.

#### 자동 출석 미지원

자동 출석 기능은 제공하지 않으며, 앞으로도 제공할 계획이 없습니다.  
출석은 Jungle Campus 출석 페이지에서 직접 진행해야 합니다.

#### 문의

새 기능·보완 요청은 Discussions의 **건의하기**에, 그 외 내용은 **궁금해요**에 남겨 주세요. 재현 가능한 버그 제보만 [버그 양식](https://github.com/YangSiJun528/jungle-bell/issues/new?template=bug.yml)을 사용합니다.

## 라이선스

[Apache License 2.0](LICENSE)
