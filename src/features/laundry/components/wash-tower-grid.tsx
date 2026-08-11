import type {DashboardLaundryMachine} from '../../../dashboard-model';
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
    men: 'bg-blue-600 text-white',
    common: 'bg-violet-600 text-white',
    women: 'bg-rose-600 text-white',
    other: 'bg-muted-foreground text-background',
};

export function WashTowerGrid({machines, nowMs = Date.now()}: WashTowerGridProps) {
    const towers = sortWashTowers(machines);
    if (towers.length === 0) return null;

    return (
        <div
            aria-label="워시타워 상태표"
            className="mt-4 overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                        className={`mx-auto grid size-7 place-items-center rounded-md border ${zone.numberClassName}`}
                                        data-laundry-zone-number="true"
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
                                        ? 'bg-destructive text-white'
                                        : 'bg-muted-foreground text-background';

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
