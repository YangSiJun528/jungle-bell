import {AlertCircle, Inbox, LoaderCircle} from 'lucide-react';

import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';

export function PageSkeleton() {
    return (
        <div aria-label="화면을 불러오는 중" className="space-y-6" role="status">
            <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-9 w-24" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
            </div>
            <Skeleton className="h-72 w-full" />
        </div>
    );
}

export function MealHistorySkeleton() {
    return (
        <div
            aria-label="지난 급식 기록을 불러오는 중"
            className="grid gap-4 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]"
            role="status"
        >
            <Skeleton className="h-80 w-full" />
            <div className="space-y-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-72 w-full" />
            </div>
        </div>
    );
}

export function LoadingState({label = '정보를 불러오고 있습니다.'}: {label?: string}) {
    return (
        <div className="flex min-h-32 items-center justify-center gap-2 rounded-lg bg-muted/60 p-6 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            {label}
        </div>
    );
}

export function ErrorState({
    title = '정보를 불러오지 못했습니다.',
    description,
    retry,
}: {
    title?: string;
    description?: string;
    retry?: () => void;
}) {
    return (
        <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{title}</AlertTitle>
            {description || retry ? (
                <AlertDescription>
                    {description ? <p>{description}</p> : null}
                    {retry ? (
                        <Button className="mt-2" size="sm" variant="outline" onClick={retry}>
                            새로고침
                        </Button>
                    ) : null}
                </AlertDescription>
            ) : null}
        </Alert>
    );
}

export function EmptyState({title, description}: {title: string; description?: string}) {
    return (
        <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-6 text-center">
            <Inbox aria-hidden="true" className="mb-2 size-5 text-muted-foreground" />
            <strong className="text-sm">{title}</strong>
            {description ? (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            ) : null}
        </div>
    );
}
