import type {LaundryRiskLevel} from '@/domain/laundry/status';

export interface LaundryRiskData {
    attempts: number;
    errors: number;
    rate: number;
    riskLevel: LaundryRiskLevel;
}

export interface LaundryRiskNotice {
    label: '약간 주의' | '주의';
    summary: string;
    description: string;
}

function percentage(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function visibleLaundryRiskLevel(
    value: {riskLevel?: LaundryRiskLevel} | null | undefined,
): Exclude<LaundryRiskLevel, 'safe'> | null {
    return value?.riskLevel === 'slight' || value?.riskLevel === 'caution'
        ? value.riskLevel
        : null;
}

export function laundryRiskNotice(value: LaundryRiskData): LaundryRiskNotice | null {
    const riskLevel = visibleLaundryRiskLevel(value);
    if (riskLevel === null) return null;

    return {
        label: riskLevel === 'caution' ? '주의' : '약간 주의',
        summary: `${value.attempts}번 중 에러 ${value.errors}번 · 에러율 ${percentage(value.rate)}%`,
        description: riskLevel === 'caution'
            ? '오류 가능성이 높아 다른 기기 이용을 권장합니다.'
            : '오류가 반복되면 다른 기기를 이용하세요.',
    };
}
