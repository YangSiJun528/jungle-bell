export const AUTO_UPDATE_DISABLE_CONFIRMATION = {
    title: '자동 업데이트 끄기',
    message: '자동 업데이트를 끄면 LMS 등 외부 서비스 변경으로 출석 확인이나 알림이 정상적으로 작동하지 않을 수 있습니다.\n'
        + '안정적인 사용을 위해 켜두는 것을 권장합니다.',
    okLabel: '그래도 끄기',
    cancelLabel: '취소',
} as const;

export function requiresAutoUpdateDisableConfirmation(enabled: boolean): boolean {
    return !enabled;
}
