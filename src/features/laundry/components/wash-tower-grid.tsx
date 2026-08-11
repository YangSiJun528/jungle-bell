import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {
    sortWashTowers,
    washTowerCellView,
    washTowerHeading,
    WASH_TOWER_ROWS,
} from '../lib/wash-tower';
import {laundryZoneMeta} from '../lib/laundry-zone';

export interface WashTowerGridProps {
    machines: readonly DashboardLaundryMachine[];
    nowMs?: number;
}

const availableCellClasses: Record<DashboardLaundryMachine['zone'], string> = {
    men: 'bg-[oklch(0.68_0.07_250)] text-[oklch(0.24_0.04_250)] dark:bg-[oklch(0.42_0.055_250)] dark:text-[oklch(0.93_0.025_250)]',
    common: 'bg-[oklch(0.68_0.065_300)] text-[oklch(0.24_0.04_300)] dark:bg-[oklch(0.42_0.05_300)] dark:text-[oklch(0.93_0.025_300)]',
    women: 'bg-[oklch(0.68_0.07_15)] text-[oklch(0.24_0.04_15)] dark:bg-[oklch(0.42_0.055_15)] dark:text-[oklch(0.93_0.025_15)]',
    other: 'bg-muted text-foreground',
};

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
                            const zone = laundryZoneMeta(machine.zone);

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
                                    ? availableCellClasses[machine.zone]
                                    : cell.state === 'error'
                                        ? 'bg-[oklch(0.68_0.055_25)] text-[oklch(0.24_0.04_25)] dark:bg-[oklch(0.42_0.045_25)] dark:text-[oklch(0.93_0.025_25)]'
                                        : 'bg-muted text-muted-foreground';

                                return (
                                    <td className="h-10 p-0" key={`${row.kind}-${machine.id}`}>
                                        <span
                                            aria-label={cell.label}
                                            className={`grid h-10 w-full place-items-center rounded-md text-xs font-bold tabular-nums ${tone}`}
                                            data-wash-tower-cell="true"
                                            data-machine-id={machine.id}
                                            data-state={cell.state}
                                            data-zone={machine.zone}
                                            title={cell.label}
                                        >
                                            {cell.text}
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
