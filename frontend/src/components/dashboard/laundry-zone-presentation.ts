import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';

export type LaundryZone = DashboardLaundryMachine['zone'];

interface LaundryZonePresentation {
    label: string;
    numberClassName: string;
    shortLabel: string;
    surfaceClassName: string;
}

const LAUNDRY_ZONE_PRESENTATION: Readonly<Record<LaundryZone, LaundryZonePresentation>> = {
    men: {
        shortLabel: '남성',
        label: '남성 구역',
        numberClassName: 'text-blue-800 dark:text-blue-200',
        surfaceClassName:
            'border-blue-400 bg-blue-100 text-blue-800 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-200',
    },
    common: {
        shortLabel: '공용',
        label: '공용 구역',
        numberClassName: 'text-violet-800 dark:text-violet-200',
        surfaceClassName:
            'border-violet-400 bg-violet-100 text-violet-800 dark:border-violet-500 dark:bg-violet-950 dark:text-violet-200',
    },
    women: {
        shortLabel: '여성',
        label: '여성 구역',
        numberClassName: 'text-rose-800 dark:text-rose-200',
        surfaceClassName:
            'border-rose-400 bg-rose-100 text-rose-800 dark:border-rose-500 dark:bg-rose-950 dark:text-rose-200',
    },
    other: {
        shortLabel: '기타',
        label: '기타 구역',
        numberClassName: 'text-muted-foreground',
        surfaceClassName: 'border-border bg-muted text-muted-foreground',
    },
};

export function laundryZonePresentation(zone: LaundryZone): LaundryZonePresentation {
    return LAUNDRY_ZONE_PRESENTATION[zone];
}
