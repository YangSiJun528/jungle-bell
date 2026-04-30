<p></p>
<img src="docs/files/logo.png" height=100" alt="Jungle Bell" align="left"/>

<div>
<h3>Jungle Bell</h3>
<p>크래프톤 정글 출석 체크 리마인더.<br>시스템 트레이에서 출석 상태를 실시간으로 확인할 수 있으며, 학습 시작/종료가 필요할 때 아이콘 색상과 알림으로 알려줍니다.</p>
</div>

<hr>

[![GitHub Release](https://img.shields.io/github/v/release/YangSiJun528/jungle-bell?include_prereleases)](https://github.com/YangSiJun528/jungle-bell/releases)
[![License](https://img.shields.io/github/license/YangSiJun528/jungle-bell)](LICENSE)
[![Release](https://img.shields.io/github/actions/workflow/status/YangSiJun528/jungle-bell/release.yml)](https://github.com/YangSiJun528/jungle-bell/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)]()
[![Stars](https://img.shields.io/github/stars/YangSiJun528/jungle-bell)](https://github.com/YangSiJun528/jungle-bell)

<br/>

> [!CAUTION]     
> 1. **이 앱은 크래프톤 정글의 공식 앱이 아닙니다.**    
> SW-AI Lab 12기인 한 정글러가 관리하는 비공식 앱입니다.    
> 기능 관련 버그나 문의는 [이슈](https://github.com/YangSiJun528/jungle-bell/issues)를 통해 제보해 주세요.   
> 2. **자동 출석 기능은 제공하지 않으며, 앞으로도 제공할 계획이 없습니다.**   
> 자동화된 방식으로 출석을 처리하는 행위는 불이익을 받을 수 있습니다.   
> 제작자는 이러한 사용을 지원하거나 권장하지 않습니다.  

## 데모
<p align="center">
    <img src="docs/files/demo_20260315.gif" alt="demo.gif">
</p>

## 주요 기능

- **출석 상태 실시간 확인** — 트레이 아이콘 색상으로 현재 상태를 한눈에 확인
- **출석 알림** — 출석이 필요한 시간대에 시스템 알림으로 반복 알림 (시간대, 간격 설정 가능)
- **시작 시 자동 실행** — 컴퓨터를 켜면 앱이 자동으로 실행

## 상태 표시

| 상태 | 아이콘                                                            | 설명 |
|------|----------------------------------------------------------------|------|
| 로그인 필요 | <img src="docs/files/macos-tray-need-login.png" width="180">   | 로그인이 필요할 때 오렌지색으로 표시됩니다. |
| 출석 필요 | <img src="docs/files/macos-tray-need-checkin.png" width="180"> | 학습 시작 또는 종료가 필요할 때 빨간색으로 표시됩니다. |
| 학습 중 | <img src="docs/files/macos-tray-studying.png" width="180">     | 정상적으로 학습 중일 때 흰색으로 표시됩니다. |

## 트레이 메뉴

<img src="docs/files/macos-tray-studying.png" width="300">

| 항목 | 설명 |
|-----|------|
| 현재 상태 | 현재 출석 상태와 다음 액션까지의 남은 시간을 표시합니다. |
| 출석 페이지 열기 | 출석 페이지를 앱 내부 브라우저로 엽니다. 이 창을 통해 로그인해야 출석 상태를 확인할 수 있습니다. |
| 설정 | 앱 설정을 엽니다. |
| 종료 | 앱을 종료합니다. |

## 설치

한 줄로 최신 버전을 설치하고 바로 열 수 있습니다. 자동 설치가 어렵다면 [Release 페이지](https://github.com/YangSiJun528/jungle-bell/releases/latest)의 안내를 참고하세요.

### macOS

```bash
curl -fsSL https://install.sijun-yang.com/jungle-bell.sh | sh
```

### Windows

```powershell
irm https://install.sijun-yang.com/jungle-bell.ps1 | iex
```

### 특정 버전 설치

URL 끝에 `?tag=vX.Y.Z`를 붙이면 해당 버전으로 설치됩니다. 사용 가능한 태그는 [Releases](https://github.com/YangSiJun528/jungle-bell/releases) 페이지에서 확인하세요.

```bash
# macOS
curl -fsSL "https://install.sijun-yang.com/jungle-bell.sh?tag=v0.2.5" | sh
```

```powershell
# Windows
irm "https://install.sijun-yang.com/jungle-bell.ps1?tag=v0.2.5" | iex
```

## 처음 실행 시

1. 앱을 실행하고 온보딩 안내를 확인하세요.
2. 온보딩에서 **출석 페이지 열기** 를 눌러 Jungle Campus에 로그인하세요.
3. 메뉴 바(macOS) 또는 작업 표시줄(Windows)의 Jungle Bell 아이콘 색으로 출석 상태를 확인하세요.
4. 아이콘을 클릭해 출석 페이지 열기, 설정 같은 기능을 사용할 수 있어요.

## 문제가 생겼나요?

#### 아이콘이 안 보여요.

macOS는 메뉴 바 오른쪽을 확인해 주세요.

Windows는 작업 표시줄 오른쪽을 확인해 주세요. 처음에는 숨겨진 아이콘 메뉴(∧)에 있을 수 있어요.

#### 로그인이 필요하다고 떠요.

Jungle Bell 안에서 **출석 페이지 열기** 를 눌러 Jungle Campus에 로그인해 주세요.

#### 알림이 오지 않아요.

설정의 알림 탭에서 필요한 알림이 켜져 있는지 확인해 주세요.

알림을 꺼도 메뉴 바나 작업 표시줄의 Jungle Bell 아이콘 색으로 상태를 볼 수 있어요.

#### 설치 중 경고가 떠요.

자동 설치 명령을 사용하는 것을 권장합니다.
직접 다운로드해서 설치하다 막히면 [Release 페이지](https://github.com/YangSiJun528/jungle-bell/releases/latest)의 안내를 확인해 주세요.

#### 출석 상태가 실제와 달라요.

**출석 페이지 열기** 를 눌러 로그인 상태를 다시 확인해 주세요. 계속 다르면 [문의](#문의하기)해 주세요.

## 라이선스

[Apache License 2.0](LICENSE)

## 문의하기

버그나 사용 중 막힌 부분은 아래 경로로 알려주세요.

- [GitHub Issue](https://github.com/YangSiJun528/jungle-bell/issues/new/choose)
- [크래프톤 정글 Slack](https://krafton-aliens.slack.com/team/U0AHGCT20DQ)
- [이메일](mailto:yangsijun5528@gmail.com)

문의할 때 사용 중인 OS, 막힌 화면, 가능하면 스크린샷을 함께 보내주시면 좋아요.
