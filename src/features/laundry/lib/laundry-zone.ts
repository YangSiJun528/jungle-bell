import type {DashboardLaundryMachine} from '@/dashboard-model';

export type LaundryZone = DashboardLaundryMachine['zone'];

interface LaundryZoneMeta {
    badgeClassName: string;
    label: string;
    numberClassName: string;
    shortLabel: string;
}

const LAUNDRY_ZONE_META: Readonly<Record<LaundryZone, LaundryZoneMeta>> = {
    men: {
        shortLabel: '남성',
        label: '남성 구역',
        badgeClassName: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300',
        numberClassName: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300',
    },
    common: {
        shortLabel: '공용',
        label: '공용 구역',
        badgeClassName: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300',
        numberClassName: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300',
    },
    women: {
        shortLabel: '여성',
        label: '여성 구역',
        badgeClassName: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300',
        numberClassName: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300',
    },
    other: {
        shortLabel: '기타',
        label: '기타 구역',
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        numberClassName: 'border-border bg-muted text-muted-foreground',
    },
};

export function laundryZoneMeta(zone: LaundryZone): LaundryZoneMeta {
    return LAUNDRY_ZONE_META[zone];
}
