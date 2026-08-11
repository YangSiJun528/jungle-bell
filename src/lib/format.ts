const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'Asia/Seoul',
});

const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
});

export function todayLabel(now = new Date()): string {
    return dateFormatter.format(now);
}

export function dateTimeLabel(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '확인 기록 없음';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '확인 기록 없음' : dateTimeFormatter.format(date);
}

export function relativeTimeLabel(value: string | number | null | undefined, now = Date.now()): string {
    if (value === null || value === undefined) return '확인 기록 없음';
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '확인 기록 없음';
    const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return dateTimeFormatter.format(new Date(timestamp));
}
