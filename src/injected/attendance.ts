// LMS 출석 WebView에서 실행되는 최소 권한 스크립트.
// Jungle Bell의 기수 선택을 LMS 로컬 스토리지에 맞추고,
// 사용자의 정확한 "학습 시작" 클릭만 Rust에 알린다.
// 학습 시작 후 새로고침 여부는 hidden checker의 서버 조회 결과로 결정한다.

interface TauriGlobal {
    core: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
}

interface Window {
    __TAURI__: TauriGlobal;
}

const LMS_ORIGIN = 'https://jungle-lms.krafton.com';
const SELECTED_COHORT_STORAGE_KEY = 'selected_cohort_id';

let interactionReportInFlight = false;
let cohortSyncInFlight = false;

async function syncSelectedCohortStorage(): Promise<void> {
    if (window.location.origin !== LMS_ORIGIN || !window.__TAURI__?.core || cohortSyncInFlight) {
        return;
    }

    cohortSyncInFlight = true;
    try {
        let current = window.localStorage.getItem(SELECTED_COHORT_STORAGE_KEY);
        if (current !== null && !isSerializedLmsSelectedCohortId(current)) {
            window.localStorage.removeItem(SELECTED_COHORT_STORAGE_KEY);
            current = null;
        }

        const cohortId = await window.__TAURI__.core.invoke<string | null>(
            'get_attendance_cohort_id',
            {pageUrl: window.location.href},
        );
        const next = serializeLmsSelectedCohortId(cohortId);
        current = window.localStorage.getItem(SELECTED_COHORT_STORAGE_KEY);
        if (current === next) return;

        if (next === null) {
            window.localStorage.removeItem(SELECTED_COHORT_STORAGE_KEY);
        } else {
            window.localStorage.setItem(SELECTED_COHORT_STORAGE_KEY, next);
        }
        window.location.reload();
    } catch {
        // LMS 페이지 자체 동작은 기수 동기화 실패와 무관하게 유지한다.
    } finally {
        cohortSyncInFlight = false;
    }
}

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
void syncSelectedCohortStorage();
