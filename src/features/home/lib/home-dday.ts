import type {
    AttendanceDashboard,
    DashboardHomeOverview,
} from '@/api/dashboard-api';
import {
    buildDdayProgress,
    kstDateString,
    type DdayPeriod,
    type DdayProgress,
} from './dday-progress';
import {dashboardDdayLabel, dashboardDdayPeriod} from './home-overview';

export interface HomeDdayView {
    text: string;
    period: DdayPeriod | null;
    progress: DdayProgress | null;
}

export interface HomeDdayInput {
    surface: 'public' | 'desktop' | 'companion';
    overview?: DashboardHomeOverview;
    attendance?: AttendanceDashboard;
    today?: string;
}

function personalAttendanceSnapshot(attendance?: AttendanceDashboard) {
    if (attendance?.state !== 'loaded' || attendance.attendance.status !== 'available') return null;
    return attendance.attendance.snapshot;
}

export function selectHomeDday({
    surface,
    overview,
    attendance,
    today = kstDateString(),
}: HomeDdayInput): HomeDdayView | null {
    if (surface === 'public') return null;

    const snapshot = personalAttendanceSnapshot(attendance);
    const candidatePeriod = overview?.attendance.ddayPeriod
        ?? (snapshot ? dashboardDdayPeriod(snapshot) : null);
    const progress = candidatePeriod ? buildDdayProgress(candidatePeriod, today) : null;
    const period = progress ? candidatePeriod : null;
    const text = overview?.attendance.ddayText
        ?? (snapshot ? dashboardDdayLabel(snapshot, today) : null);

    if (!text && !progress) return null;
    return {
        text: text ?? '과정 일정 확인 중',
        period,
        progress,
    };
}
