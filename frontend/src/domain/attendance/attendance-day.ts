const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
export const ATTENDANCE_DAY_START_HOUR_KST = 4;

/**
 * 출석 하루는 KST 04:00에 바뀐다. 자정부터 03:59까지는 전날의 학습 종료
 * 구간이므로 달력 날짜가 아니라 이전 출석일을 반환한다.
 */
export function effectiveAttendanceDate(timestamp = Date.now()): string {
    const kst = new Date(timestamp + KST_OFFSET_MS);
    if (kst.getUTCHours() < ATTENDANCE_DAY_START_HOUR_KST) {
        kst.setUTCDate(kst.getUTCDate() - 1);
    }
    return kst.toISOString().slice(0, 10);
}
