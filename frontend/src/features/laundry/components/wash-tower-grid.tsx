import {TriangleAlert} from 'lucide-react';
import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {
    sortWashTowers,
    washTowerCellView,
    washTowerHeading,
    WASH_TOWER_ROWS,
} from '../lib/wash-tower';
import {laundryZonePresentation} from '@/components/dashboard/laundry-zone-presentation';
import {LAUNDRY_WARNING_CLASS_NAME} from '../lib/laundry-warning';

export interface WashTowerGridProps {
    machines: readonly DashboardLaundryMachine[];
    nowMs?: number;
}

export function WashTowerGrid({machines, nowMs = Date.now()}: WashTowerGridProps) {
    const towers = sortWashTowers(machines);
    if (towers.length === 0) return null;

    return (
        <div
            aria-label="워시타워 상태표"
            className="overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            tabIndex={0}
        >
            <table className="w-full min-w-[620px] table-fixed border-separate border-spacing-1">
                <caption className="sr-only">워시타워 번호별 세탁기와 건조기 상태</caption>
                <thead>
                    <tr>
                        <th
                            className="h-6 w-[76px] p-0 text-left text-xs font-bold text-muted-foreground"
                            scope="col"
                        >
                            기기
                        </th>
                        {towers.map((machine) => {
                            const heading = washTowerHeading(machine);
                            const zone = laundryZonePresentation(machine.zone);

                            return (
                                <th
                                    className="h-8 p-0 text-center text-xs font-bold"
                                    data-machine-id={machine.id}
                                    data-zone={machine.zone}
                                    key={machine.id}
                                    scope="col"
                                >
                                    <span
                                        aria-label={`${heading}번, ${zone.label}`}
                                        className={`mx-auto block w-fit text-sm font-semibold tabular-nums ${zone.numberClassName}`}
                                        data-laundry-zone-number="true"
                                        title={zone.label}
                                    >
                                        {heading}
                                    </span>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {WASH_TOWER_ROWS.map((row) => (
                        <tr data-kind={row.kind} key={row.kind}>
                            <th
                                className="h-8 p-0 text-left text-xs font-bold text-muted-foreground"
                                scope="row"
                            >
                                {row.label}
                            </th>
                            {towers.map((machine) => {
                                const cell = washTowerCellView(machine, row.kind, nowMs);
                                const tone = cell.state === 'available'
                                    ? laundryZonePresentation(machine.zone).surfaceClassName
                                    : cell.state === 'error'
                                        ? LAUNDRY_WARNING_CLASS_NAME
                                        : 'bg-muted text-muted-foreground';

                                return (
                                    <td className="h-10 p-0" key={`${row.kind}-${machine.id}`}>
                                        <span
                                            aria-label={cell.label}
                                            className={`grid h-10 w-full place-items-center rounded-md border text-xs font-bold tabular-nums ${tone}`}
                                            data-wash-tower-cell="true"
                                            data-machine-id={machine.id}
                                            data-state={cell.state}
                                            data-zone={machine.zone}
                                            title={cell.label}
                                        >
                                            {cell.state === 'error' ? (
                                                <>
                                                    <TriangleAlert aria-hidden="true" className="size-4"/>
                                                    <span className="sr-only">경고</span>
                                                </>
                                            ) : cell.text}
                                        </span>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
