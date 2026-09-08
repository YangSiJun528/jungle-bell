import {
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    LoaderCircle,
    TriangleAlert,
    type LucideIcon,
} from 'lucide-react';

import {Button} from '@/components/ui/button';

import {type AppStatusRowModel, type AppStatusTab, type AppStatusValue} from './app-status-model';

const STATUS_PRESENTATION: Record<AppStatusValue, {badgeClassName: string; icon: LucideIcon}> = {
    ready: {
        badgeClassName:
            'border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
        icon: CheckCircle2,
    },
    attention: {
        badgeClassName: 'border-amber-600/25 bg-amber-500/10 text-amber-900 dark:text-amber-100',
        icon: TriangleAlert,
    },
    checking: {
        badgeClassName: 'border-sky-600/25 bg-sky-500/10 text-sky-800 dark:text-sky-200',
        icon: LoaderCircle,
    },
    error: {
        badgeClassName: 'border-destructive/25 bg-destructive/10 text-destructive',
        icon: CircleAlert,
    },
    unavailable: {
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        icon: CircleHelp,
    },
};

interface AppStatusRowProps {
    onOpenTab?: (tab: AppStatusTab) => void;
    row: AppStatusRowModel;
}

export function AppStatusRow({row, onOpenTab}: AppStatusRowProps) {
    const presentation = STATUS_PRESENTATION[row.status];
    const StatusIcon = presentation.icon;
    const statusText = row.status === 'unavailable' ? '확인 불가' : row.statusText;
    const description =
        row.status === 'unavailable' ? '현재 계약에서 확인할 수 없습니다.' : row.description;
    const actionTab = row.action.tab;

    return (
        <li
            data-app-status={row.status}
            className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
        >
            <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <StatusIcon
                        aria-hidden="true"
                        className={row.status === 'checking' ? 'size-4 animate-spin' : 'size-4'}
                    />
                </span>
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{row.label}</h3>
                        <div aria-live="polite" aria-atomic="true">
                            <span
                                className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${presentation.badgeClassName}`}
                            >
                                {statusText}
                            </span>
                        </div>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
                </div>
            </div>
            {actionTab && onOpenTab ? (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenTab(actionTab)}
                >
                    {row.action.label}
                </Button>
            ) : (
                <Button asChild size="sm" variant="outline">
                    <a href={row.action.href}>{row.action.label}</a>
                </Button>
            )}
        </li>
    );
}
