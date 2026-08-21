import type {LaundryCapacityEstimate, LaundryCapacitySnapshot} from '@/domain/laundry/capacity';

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
        const count =
            snapshotReliable && estimate?.reliable === true ? estimate.startableLoads : null;
        return {
            access,
            count,
            label: access === 'men' ? '남성 가능' : '여성 가능',
            status: count === null ? 'checking' : count > 0 ? 'available' : 'full',
            description:
                count === null
                    ? '최신 기기 상태 확인 중'
                    : count > 0
                      ? `건조 여유 포함 · ${count}회 시작 가능`
                      : '건조기 여유 부족',
        };
    });
}
