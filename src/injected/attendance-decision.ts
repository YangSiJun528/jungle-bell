const ATTENDANCE_CHECK_IN_ORIGIN = 'https://jungle-lms.krafton.com';
const ATTENDANCE_CHECK_IN_PATH = '/check-in';
const ATTENDANCE_START_LABEL = '학습 시작';

interface AttendanceStartClickEvidence {
    trusted: boolean;
    origin: string;
    pathname: string;
    clickedLabel: string;
    clickedDisabled: boolean;
    exactCandidateCount: number;
    clickedIsExactCandidate: boolean;
}

function normalizeAttendanceLabel(value: string | null): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeAttendancePath(pathname: string): string {
    const withoutTrailingSlash = pathname.replace(/\/+$/, '');
    return withoutTrailingSlash || '/';
}

function shouldReportAttendanceStartClick(evidence: AttendanceStartClickEvidence): boolean {
    return evidence.trusted
        && evidence.origin === ATTENDANCE_CHECK_IN_ORIGIN
        && normalizeAttendancePath(evidence.pathname) === ATTENDANCE_CHECK_IN_PATH
        && evidence.clickedLabel === ATTENDANCE_START_LABEL
        && !evidence.clickedDisabled
        && evidence.exactCandidateCount === 1
        && evidence.clickedIsExactCandidate;
}
