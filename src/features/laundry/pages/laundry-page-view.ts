import type {
    LaundryCapacityEstimate,
    LaundryCapacitySnapshot,
} from '@/dashboard-model';

export interface CapacityCardView {
    access: LaundryCapacityEstimate['access'];
    count: number | null;
    description: string;
    label: string;
    status: 'available' | 'full' | 'checking';
}

export function capacityCards(
    capacity: LaundryCapacitySnapshot | null,
    snapshotReliable: boolean,
): CapacityCardView[] {
    return (['men', 'women'] as const).map((access) => {
        const estimate = capacity?.[access] ?? null;
        const count = snapshotReliable && estimate?.reliable === true
            ? estimate.startableLoads
            : null;
        return {
            access,
            count,
            label: access === 'men' ? '남성 세탁실' : '여성 세탁실',
            status: count === null ? 'checking' : count > 0 ? 'available' : 'full',
            description: count === null
                ? '최신 기기 상태를 확인하고 있어요.'
                : count > 0
                    ? `건조 여유를 포함해 지금 ${count}회 시작할 수 있어요.`
                    : '현재는 건조기 여유가 부족해요.',
        };
    });
}
