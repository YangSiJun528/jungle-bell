// LMS 출석 WebView에서 실행되는 최소 권한 스크립트.
// 사용자의 정확한 "학습 시작" 클릭만 Rust에 알리며,
// 새로고침 여부는 hidden checker의 서버 조회 결과로 결정한다.

interface TauriGlobal {
    core: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
}

interface Window {
    __TAURI__: TauriGlobal;
}

let interactionReportInFlight = false;

function attendanceButtonLabel(button: HTMLButtonElement): string {
    const ariaLabel = normalizeAttendanceLabel(button.getAttribute('aria-label'));
    return ariaLabel || normalizeAttendanceLabel(button.textContent);
}

function handleAttendanceClick(event: MouseEvent): void {
    if (!event.isTrusted || interactionReportInFlight) return;
    if (!(event.target instanceof Element)) return;

    const clickedButton = event.target.closest('button');
    if (!(clickedButton instanceof HTMLButtonElement)) return;

    const exactCandidates = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => attendanceButtonLabel(button) === ATTENDANCE_START_LABEL);
    const evidence: AttendanceStartClickEvidence = {
        trusted: event.isTrusted,
        origin: window.location.origin,
        pathname: window.location.pathname,
        clickedLabel: attendanceButtonLabel(clickedButton),
        clickedDisabled: clickedButton.disabled,
        exactCandidateCount: exactCandidates.length,
        clickedIsExactCandidate: exactCandidates.length === 1 && exactCandidates[0] === clickedButton,
    };

    if (!shouldReportAttendanceStartClick(evidence)) return;
    if (!window.__TAURI__?.core) return;

    interactionReportInFlight = true;
    void window.__TAURI__.core.invoke('report_attendance_start_clicked', {
        pageUrl: window.location.href,
    }).then(
        () => {
            interactionReportInFlight = false;
        },
        () => {
            interactionReportInFlight = false;
        },
    );
}

document.addEventListener('click', handleAttendanceClick, true);
