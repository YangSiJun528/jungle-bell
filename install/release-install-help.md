<!-- jungle-bell-install-help:start -->

## 설치가 막힐 때

가능하면 자동 설치 명령을 사용해 주세요. 사용하는 컴퓨터에 맞는 파일을 받아 설치하고 바로 앱을 엽니다.

설치 파일을 직접 받고 싶다면 이 Release 페이지 아래쪽의 `Assets`에서 파일을 선택해 주세요.

### macOS

자동 설치:

```bash
curl -fsSL https://install.sijun-yang.com/jungle-bell.sh | sh
```

수동 설치:

1. Apple Silicon Mac은 `Jungle Bell_x.x.x_aarch64.dmg`를 받습니다.
2. Intel Mac은 `Jungle Bell_x.x.x_x64.dmg`를 받습니다.
3. 받은 `.dmg`를 열고 `Jungle Bell.app`을 Applications 폴더로 옮깁니다.
4. 앱 실행이 막히면 아래 명령을 실행합니다.

```bash
xattr -cr "/Applications/Jungle Bell.app"
open "/Applications/Jungle Bell.app"
```

Mac 종류를 모르겠다면 왼쪽 상단 Apple 메뉴에서 `이 Mac에 관하여`를 확인해 주세요.

### Windows

자동 설치:

```powershell
irm https://install.sijun-yang.com/jungle-bell.ps1 | iex
```

수동 설치:

1. `Jungle Bell_x.x.x_x64-setup.exe`를 받습니다.
2. 받은 설치 파일을 실행합니다.
3. `Windows의 PC 보호` 화면이 나오면 `추가 정보`를 누른 뒤 `실행`을 선택합니다.

계속 막히면 아래 경로로 알려주세요.

- [GitHub Issue](https://github.com/YangSiJun528/jungle-bell/issues/new/choose)
- [크래프톤 정글 Slack](https://krafton-aliens.slack.com/team/U0AHGCT20DQ)
- [이메일](mailto:yangsijun5528@gmail.com)

<!-- jungle-bell-install-help:end -->
