import {dashboardDdayLabel, dashboardDdayPeriod, type DdayAttendanceSnapshot} from './dday-label';
import {
    buildDdayProgress,
    kstDateString,
    type DdayPeriod,
    type DdayProgress,
} from './dday-progress';

export interface DdayView {
    text: string;
    period: DdayPeriod | null;
    progress: DdayProgress | null;
}

export interface DdayViewInput {
    platform: 'browser' | 'desktop';
    attendance?: DdayAttendanceDashboard;
    today?: string;
}

export interface DdayAttendanceDashboard {
    state: string;
    attendance?: {
        status: string;
        snapshot: DdayAttendanceSnapshot | null;
    };
}

function personalAttendanceSnapshot(attendance?: DdayAttendanceDashboard) {
    if (attendance?.state !== 'loaded' || attendance.attendance?.status !== 'available')
        return null;
    return attendance.attendance.snapshot;
}

export function selectDdayView({
    attendance,
    today = kstDateString(),
}: DdayViewInput): DdayView | null {
    const snapshot = personalAttendanceSnapshot(attendance);
    const candidatePeriod = snapshot ? dashboardDdayPeriod(snapshot) : null;
    const progress = candidatePeriod ? buildDdayProgress(candidatePeriod, today) : null;
    const period = progress ? candidatePeriod : null;
    const text = snapshot ? dashboardDdayLabel(snapshot, today) : null;

    if (!text && !progress) return null;
    return {
        text: text ?? '과정 일정 확인 중',
        period,
        progress,
    };
}
