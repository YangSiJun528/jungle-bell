import {onlineManager} from '@tanstack/react-query';
import {AlertCircle, Inbox, LoaderCircle} from 'lucide-react';
import {type ReactNode, useSyncExternalStore} from 'react';

import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';

export type AsyncStateType =
    | 'loading'
    | 'normal'
    | 'empty'
    | 'stale'
    | 'offline'
    | 'error'
    | 'recovered';

export interface AsyncRegionProps {
    regionLabel?: string;
    regionLabelledBy?: string;
}

interface BaseAsyncStateProps extends AsyncRegionProps {
    title?: string;
    description?: string;
}

interface LoadingStateProps extends Omit<BaseAsyncStateProps, 'title' | 'description'> {
    label?: string;
}

interface EmptyStateProps extends BaseAsyncStateProps {
    title: string;
}

interface TimedStateProps extends BaseAsyncStateProps {
    lastUpdatedAt?: string;
    reason?: string;
    retryLabel?: string;
    retry?: () => void;
}

type TimedStateType = Extract<AsyncStateType, 'stale' | 'offline' | 'recovered'>;

const TIMED_STATE_LABELS: Readonly<Record<TimedStateType, string>> = {
    stale: '데이터가 최신이 아닙니다.',
    offline: '네트워크 연결이 일시 중단되었습니다.',
    recovered: '마지막 상태를 복구했습니다.',
};

export type AsyncStateProps =
    | ({type: 'normal'} & AsyncRegionProps & {children?: ReactNode})
    | ({type: 'loading'} & LoadingStateProps)
    | ({type: 'empty'} & EmptyStateProps)
    | ({type: 'stale' | 'offline' | 'recovered'} & TimedStateProps)
    | ({type: 'error'} & BaseAsyncStateProps & {retry?: () => void; retryLabel?: string});

function getRegionAttributes(regionProps: AsyncRegionProps) {
    const {regionLabel, regionLabelledBy} = regionProps;

    if (regionLabelledBy) {
        return {'aria-labelledby': regionLabelledBy};
    }

    if (regionLabel) {
        return {'aria-label': regionLabel};
    }

    return null;
}

function withRegion(children: ReactNode, regionProps: AsyncRegionProps) {
    const regionAttributes = getRegionAttributes(regionProps);

    if (!regionAttributes) {
        return children;
    }

    return (
        <div role="region" {...regionAttributes}>
            {children}
        </div>
    );
}

function subscribeToOnlineStatus(notify: () => void) {
    return onlineManager.subscribe(() => notify());
}

/** Shares TanStack Query's online source without adding duplicate window listeners. */
export function useOnlineStatus(): boolean {
    return useSyncExternalStore(
        subscribeToOnlineStatus,
        () => onlineManager.isOnline(),
        () => true,
    );
}

function withStatus(children: ReactNode, regionProps: AsyncRegionProps) {
    return withRegion(
        <div role="status" aria-live="polite">
            {children}
        </div>,
        regionProps,
    );
}

function statusDescriptionRows(lastUpdatedAt?: string, reason?: string) {
    return (
        <>
            {lastUpdatedAt ? (
                <p className="text-sm leading-5 text-muted-foreground">
                    마지막 정상 시각: <span className="font-medium">{lastUpdatedAt}</span>
                </p>
            ) : null}
            {reason ? <p className="text-base leading-6">이유: {reason}</p> : null}
        </>
    );
}

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

export function LoadingState({
    label = '정보를 불러오고 있습니다.',
    regionLabel,
    regionLabelledBy,
}: {
    label?: string;
    regionLabel?: string;
    regionLabelledBy?: string;
}) {
    return withStatus(
        <div className="flex min-h-32 items-center justify-center gap-2 rounded-lg bg-muted/60 p-6 text-base leading-6 text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            {label}
        </div>,
        {regionLabel, regionLabelledBy},
    );
}

export function ErrorState({
    title = '정보를 불러오지 못했습니다.',
    description,
    retry,
    retryLabel = '새로고침',
    regionLabel,
    regionLabelledBy,
}: {
    title?: string;
    description?: string;
    retry?: () => void;
    retryLabel?: string;
    regionLabel?: string;
    regionLabelledBy?: string;
}) {
    return withRegion(
        <Alert aria-live="assertive" variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle className="text-base leading-6">{title}</AlertTitle>
            {description || retry ? (
                <AlertDescription className="text-base leading-6">
                    {description ? <p>{description}</p> : null}
                    {retry ? (
                        <Button
                            className="mt-2 min-h-11"
                            size="sm"
                            variant="outline"
                            onClick={retry}
                        >
                            {retryLabel}
                        </Button>
                    ) : null}
                </AlertDescription>
            ) : null}
        </Alert>,
        {regionLabel, regionLabelledBy},
    );
}

export function EmptyState({
    title,
    description,
    regionLabel,
    regionLabelledBy,
}: {
    title: string;
    description?: string;
    regionLabel?: string;
    regionLabelledBy?: string;
}) {
    return withRegion(
        <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-6 text-center">
            <Inbox aria-hidden="true" className="mb-2 size-5 text-muted-foreground" />
            <strong className="text-base leading-6">{title}</strong>
            {description ? (
                <p className="mt-1 text-base leading-6 text-muted-foreground">{description}</p>
            ) : null}
        </div>,
        {regionLabel, regionLabelledBy},
    );
}

export function AsyncState(props: AsyncStateProps) {
    if (props.type === 'normal') {
        return withRegion(props.children ?? null, {
            regionLabel: props.regionLabel,
            regionLabelledBy: props.regionLabelledBy,
        });
    }

    if (props.type === 'loading') {
        return (
            <LoadingState
                label={props.label}
                regionLabel={props.regionLabel}
                regionLabelledBy={props.regionLabelledBy}
            />
        );
    }

    if (props.type === 'empty') {
        return (
            <EmptyState
                title={props.title}
                description={props.description}
                regionLabel={props.regionLabel}
                regionLabelledBy={props.regionLabelledBy}
            />
        );
    }

    if (props.type === 'error') {
        return (
            <ErrorState
                description={props.description}
                regionLabel={props.regionLabel}
                regionLabelledBy={props.regionLabelledBy}
                retry={props.retry}
                retryLabel={props.retryLabel}
                title={props.title}
            />
        );
    }

    return withStatus(
        <div className="space-y-2 text-base leading-6 text-muted-foreground">
            <p className="font-medium text-foreground">
                {props.title ?? TIMED_STATE_LABELS[props.type]}
            </p>
            {props.description ? <p>{props.description}</p> : null}
            {statusDescriptionRows(props.lastUpdatedAt, props.reason)}
            {props.retry ? (
                <Button className="mt-2 min-h-11" size="sm" variant="outline" onClick={props.retry}>
                    {props.retryLabel ?? '다시 시도'}
                </Button>
            ) : null}
        </div>,
        {
            regionLabel: props.regionLabel,
            regionLabelledBy: props.regionLabelledBy,
        },
    );
}
