import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {
    laundryAvailabilityState,
    laundryOverviewText,
    laundryRemainingText,
    type LaundryAvailabilityState,
} from '@/domain/laundry/status';

export type WashTowerApplianceKind = 'dryer' | 'washer';

export interface WashTowerCellView {
    estimated: boolean;
    label: string;
    state: LaundryAvailabilityState;
    text: string;
}

export const WASH_TOWER_ROWS = [
    {kind: 'dryer', label: '건조기'},
    {kind: 'washer', label: '세탁기'},
] as const satisfies readonly {
    kind: WashTowerApplianceKind;
    label: string;
}[];

export function washTowerNumber(id: string): number | null {
    const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim());
    return match?.[1] ? Number(match[1]) : null;
}

export function washTowerHeading(machine: DashboardLaundryMachine): string {
    return String(washTowerNumber(machine.id) ?? machine.id);
}

export function sortWashTowers(
    machines: readonly DashboardLaundryMachine[],
): DashboardLaundryMachine[] {
    return [...machines].sort((left, right) => {
        const leftNumber = washTowerNumber(left.id);
        const rightNumber = washTowerNumber(right.id);
        if (leftNumber === null && rightNumber === null) return left.id.localeCompare(right.id, 'ko');
        if (leftNumber === null) return 1;
        if (rightNumber === null) return -1;
        return leftNumber - rightNumber || left.id.localeCompare(right.id, 'ko');
    });
}

export function washTowerCellView(
    machine: DashboardLaundryMachine,
    kind: WashTowerApplianceKind,
    nowMs = Date.now(),
): WashTowerCellView {
    const appliance = machine[kind];
    const state = laundryAvailabilityState(appliance);
    const estimated = state === 'unavailable' && appliance?.projection?.estimated === true;
    const baseText = state === 'available'
        ? '✓'
        : state === 'error'
            ? '경고'
            : laundryOverviewText(appliance, nowMs);
    const text = estimated ? `≈${baseText}` : baseText;
    const applianceLabel = kind === 'washer' ? '세탁기' : '건조기';

    return {
        estimated,
        label: `${machine.id} ${applianceLabel} ${estimated ? '예상 ' : ''}${laundryRemainingText(appliance, nowMs)}`,
        state,
        text,
    };
}
