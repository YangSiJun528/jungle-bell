export function relativeTimeKo(value: string | Date | undefined, nowMs = Date.now()): string {
    if (!value) return '확인 시각 없음';
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '확인 시각 없음';

    const seconds = Math.max(0, Math.floor((nowMs - parsed.getTime()) / 1000));
    if (seconds === 0) return '방금';
    if (seconds < 60) return `${seconds}초 전`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}
