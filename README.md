<h1 align="center">
  <img src="docs/files/logo.png" width="28" style="vertical-align: middle;">
  Jungle Bell
</h1>
<p align="center">크래프톤 정글 출석 체크 리마인더.</p>

---

시스템 트레이에서 출석 상태를 실시간으로 확인할 수 있으며, 체크인/체크아웃이 필요할 때 아이콘 색상으로 알려줍니다.

> [!CAUTION]   
> **이 앱은 크래프톤 정글의 공식 앱이 아닙니다.**  
>
> 자동 출석 기능은 제공하지 않으며, 앞으로도 제공할 계획이 없습니다.   
> 자동화된 방식으로 출석을 처리하는 행위는 불이익을 받을 수 있습니다.    
> 제작자는 이러한 사용을 지원하거나 권장하지 않습니다.

## 메뉴

<img src="docs/files/macos-tray-studying.png" width="300">

| 항목 | 설명 |
|-----|------|
| 현재 상태 | 현재 출석 상태와 다음 액션까지의 남은 시간을 표시합니다. |
| 출석 페이지 열기 | 출석 페이지를 앱 내부 브라우저로 엽니다. 이 창을 통해 로그인해야 출석 상태를 확인할 수 있습니다. |
| 설정 | 앱 설정을 엽니다. |
| 종료 | 앱을 종료합니다. |

## 상태 표시

| 상태 | 아이콘                                                            | 설명 |
|------|----------------------------------------------------------------|------|
| 로그인 필요 | <img src="docs/files/macos-tray-need-login.png" width="180">   | 로그인 상태를 확인할 수 없을 때 오렌지색으로 표시됩니다. 출석 페이지를 열어 로그인해야 합니다. |
| 액션 필요 | <img src="docs/files/macos-tray-need-checkin.png" width="180"> | 체크인 또는 체크아웃이 필요한 경우 빨간색으로 표시됩니다. 남은 시간이 함께 표시됩니다. |
| 학습 중 | <img src="docs/files/macos-tray-studying.png" width="180">     | 체크인 후 체크아웃 가능 시점까지 대기 중일 때 흰색으로 표시됩니다. |

## 설치

[Releases](https://github.com/sijun-yang/jungle-bell/releases) 페이지에서 최신 버전을 다운로드하세요.

## 라이선스

[Apache License 2.0](LICENSE)