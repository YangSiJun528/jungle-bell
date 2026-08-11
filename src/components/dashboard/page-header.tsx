import {cn} from '@/lib/utils';

export function PageHeader({title, actions, className}: {
    title: string;
    actions?: React.ReactNode;
    className?: string;
}) {
    return (
        <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
            <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        </header>
    );
}
