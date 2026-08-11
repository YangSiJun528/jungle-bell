import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';

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
        badgeClassName: 'border-blue-200/70 bg-blue-50/60 text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300',
        numberClassName: 'text-blue-700 dark:text-blue-300',
    },
    common: {
        shortLabel: '공용',
        label: '공용 구역',
        badgeClassName: 'border-violet-200/70 bg-violet-50/60 text-violet-700 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300',
        numberClassName: 'text-violet-700 dark:text-violet-300',
    },
    women: {
        shortLabel: '여성',
        label: '여성 구역',
        badgeClassName: 'border-rose-200/70 bg-rose-50/60 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300',
        numberClassName: 'text-rose-700 dark:text-rose-300',
    },
    other: {
        shortLabel: '기타',
        label: '기타 구역',
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        numberClassName: 'text-muted-foreground',
    },
};

export function laundryZoneMeta(zone: LaundryZone): LaundryZoneMeta {
    return LAUNDRY_ZONE_META[zone];
}
