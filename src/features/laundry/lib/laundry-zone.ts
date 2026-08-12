import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';

export type LaundryZone = DashboardLaundryMachine['zone'];

interface LaundryZoneMeta {
    label: string;
    numberClassName: string;
    shortLabel: string;
    surfaceClassName: string;
}

const MEN_ZONE_SURFACE =
    'border-blue-200/70 bg-blue-50/60 text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300';
const COMMON_ZONE_SURFACE =
    'border-violet-200/70 bg-violet-50/60 text-violet-700 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300';
const WOMEN_ZONE_SURFACE =
    'border-rose-200/70 bg-rose-50/60 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300';
const OTHER_ZONE_SURFACE = 'border-border bg-muted text-muted-foreground';

const LAUNDRY_ZONE_META: Readonly<Record<LaundryZone, LaundryZoneMeta>> = {
    men: {
        shortLabel: '남성',
        label: '남성 구역',
        numberClassName: 'text-blue-700 dark:text-blue-300',
        surfaceClassName: MEN_ZONE_SURFACE,
    },
    common: {
        shortLabel: '공용',
        label: '공용 구역',
        numberClassName: 'text-violet-700 dark:text-violet-300',
        surfaceClassName: COMMON_ZONE_SURFACE,
    },
    women: {
        shortLabel: '여성',
        label: '여성 구역',
        numberClassName: 'text-rose-700 dark:text-rose-300',
        surfaceClassName: WOMEN_ZONE_SURFACE,
    },
    other: {
        shortLabel: '기타',
        label: '기타 구역',
        numberClassName: 'text-muted-foreground',
        surfaceClassName: OTHER_ZONE_SURFACE,
    },
};

export function laundryZoneMeta(zone: LaundryZone): LaundryZoneMeta {
    return LAUNDRY_ZONE_META[zone];
}
