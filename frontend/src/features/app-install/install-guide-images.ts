import androidMenuImage from '@/assets/install-guide/web/android-01-menu.webp';
import androidAddHomeImage from '@/assets/install-guide/web/android-02-add-home.webp';
import androidInstallImage from '@/assets/install-guide/web/android-03-install.webp';
import iosMoreImage from '@/assets/install-guide/web/ios-01-more.webp';
import iosShareImage from '@/assets/install-guide/web/ios-02-share.webp';
import iosActionsImage from '@/assets/install-guide/web/ios-03-actions.webp';
import iosAddHomeImage from '@/assets/install-guide/web/ios-04-add-home.webp';
import iosConfirmImage from '@/assets/install-guide/web/ios-05-confirm.webp';
import iosOpenImage from '@/assets/install-guide/web/ios-06-open.webp';
import mobilePairingScreenshotImage from '@/assets/install-guide/web/mobile-pair.webp';
import notificationStartImage from '@/assets/install-guide/web/notifications-01-start.webp';
import notificationAllowImage from '@/assets/install-guide/web/notifications-02-allow.webp';
import pcPreparationScreenshotImage from '@/assets/install-guide/web/pc-prepare.webp';

import type {InstallGuideScreenshot} from './install-screenshot-guide';

export const pcPreparationScreenshot = {
    id: 'pc-prepare',
    title: 'PC에서 연결 코드 만들기',
    description: '설정 → 기기 연결 → 휴대폰 설정 QR 만들기를 누릅니다.',
    src: pcPreparationScreenshotImage,
    width: 1491,
    height: 1055,
} satisfies InstallGuideScreenshot;

export const mobilePairingScreenshot = {
    id: 'mobile-pair',
    title: '휴대폰에서 연결 요청하기',
    description:
        '홈 화면의 Jungle Bell을 열고 PC의 10자리 코드를 입력하세요. 연결 요청 후 두 화면의 확인번호를 비교하고 PC에서 승인합니다.',
    src: mobilePairingScreenshotImage,
    width: 851,
    height: 1848,
} satisfies InstallGuideScreenshot;

const iosMore = {
    id: 'ios-01-more',
    title: 'Safari 메뉴 열기',
    description: 'Safari에서 이 페이지를 열고 오른쪽 아래 더 보기(···)를 누릅니다.',
    src: iosMoreImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

const iosShare = {
    id: 'ios-02-share',
    title: '공유 선택하기',
    description: '메뉴 맨 위의 공유를 누릅니다.',
    src: iosShareImage,
    width: 851,
    height: 1848,
} satisfies InstallGuideScreenshot;

const iosActions = {
    id: 'ios-03-actions',
    title: '동작 목록 펼치기',
    description: '공유 시트 아래쪽의 더 보기(⌄)를 누릅니다. 앱 아이콘 줄의 더 보기와 구분하세요.',
    src: iosActionsImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

const iosAddHome = {
    id: 'ios-04-add-home',
    title: '홈 화면에 추가하기',
    description: '동작 목록에서 홈 화면에 추가를 누릅니다.',
    src: iosAddHomeImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

const iosConfirm = {
    id: 'ios-05-confirm',
    title: '웹 앱으로 추가하기',
    description: '웹 앱으로 열기를 켠 상태에서 오른쪽 위 추가를 누릅니다.',
    src: iosConfirmImage,
    width: 851,
    height: 1848,
} satisfies InstallGuideScreenshot;

const iosOpen = {
    id: 'ios-06-open',
    title: '설치한 앱 열기',
    description: '홈 화면에 생긴 Jungle Bell 아이콘을 눌러 실행합니다.',
    src: iosOpenImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

const androidMenu = {
    id: 'android-01-menu',
    title: 'Chrome 메뉴 열기',
    description: 'Chrome에서 이 페이지를 열고 오른쪽 위 더 보기(⋮)를 누릅니다.',
    src: androidMenuImage,
    width: 819,
    height: 1920,
} satisfies InstallGuideScreenshot;

const androidAddHome = {
    id: 'android-02-add-home',
    title: '홈 화면에 추가하기',
    description:
        '메뉴의 홈 화면에 추가를 누릅니다. Chrome 버전에 따라 앱 설치로 표시될 수 있습니다.',
    src: androidAddHomeImage,
    width: 841,
    height: 1870,
} satisfies InstallGuideScreenshot;

const androidInstall = {
    id: 'android-03-install',
    title: '설치 확인하기',
    description:
        'Jungle Bell 이름을 확인하고 설치를 누릅니다. 설치가 끝나면 홈 화면의 Jungle Bell을 엽니다.',
    src: androidInstallImage,
    width: 842,
    height: 1869,
} satisfies InstallGuideScreenshot;

const notificationStart = {
    id: 'notifications-01-start',
    title: '알림 설정 시작하기',
    description: '설치한 앱에서 PC 연결을 마친 뒤 알림 연결하고 테스트를 누릅니다.',
    src: notificationStartImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

const notificationAllow = {
    id: 'notifications-02-allow',
    title: '알림 권한 허용하기',
    description:
        '시스템 알림 요청에서 허용을 누른 뒤 테스트 알림을 확인합니다. 아래 화면은 iPhone 예시입니다.',
    src: notificationAllowImage,
    width: 851,
    height: 1849,
} satisfies InstallGuideScreenshot;

export const iosInstallScreenshots = [
    iosMore,
    iosShare,
    iosActions,
    iosAddHome,
    iosConfirm,
    iosOpen,
] as const satisfies readonly InstallGuideScreenshot[];

export const androidInstallScreenshots = [
    androidMenu,
    androidAddHome,
    androidInstall,
] as const satisfies readonly InstallGuideScreenshot[];

export const notificationSetupScreenshots = [
    notificationStart,
    notificationAllow,
] as const satisfies readonly InstallGuideScreenshot[];
