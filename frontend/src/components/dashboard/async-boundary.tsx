import {QueryErrorResetBoundary} from '@tanstack/react-query';
import {Suspense, type ReactNode} from 'react';
import {ErrorBoundary} from 'react-error-boundary';

import {ErrorState, PageSkeleton} from './async-state';

export interface AsyncBoundaryErrorFallbackProps {
    error: unknown;
    retry: () => void;
}

export interface AsyncBoundaryProps {
    children: ReactNode;
    errorDescription?: string;
    errorTitle?: string;
    fallback?: ReactNode;
    header?: string;
    regionLabel?: string;
    regionLabelledBy?: string;
    renderError?: (props: AsyncBoundaryErrorFallbackProps) => ReactNode;
    resetKeys?: unknown[];
}

function getBoundaryRegionAttributes({
    header,
    regionLabel,
    regionLabelledBy,
}: Pick<AsyncBoundaryProps, 'header' | 'regionLabel' | 'regionLabelledBy'>) {
    if (regionLabelledBy) {
        return {'aria-labelledby': regionLabelledBy, role: 'region' as const};
    }

    if (regionLabel) {
        return {'aria-label': regionLabel, role: 'region' as const};
    }

    if (header) {
        return {'aria-label': header, role: 'region' as const};
    }

    return null;
}

export function AsyncBoundary({
    children,
    errorDescription,
    errorTitle,
    fallback = <PageSkeleton />,
    header,
    regionLabel,
    regionLabelledBy,
    renderError,
    resetKeys,
}: AsyncBoundaryProps) {
    const regionAttributes = getBoundaryRegionAttributes({header, regionLabel, regionLabelledBy});

    return (
        <QueryErrorResetBoundary>
            {({reset}) => (
                <ErrorBoundary
                    fallbackRender={({error, resetErrorBoundary}) => {
                        const feedback = renderError ? (
                            renderError({error, retry: resetErrorBoundary})
                        ) : (
                            <ErrorState
                                description={errorDescription}
                                retry={resetErrorBoundary}
                                title={errorTitle}
                            />
                        );

                        return regionAttributes ? (
                            <section {...regionAttributes}>{feedback}</section>
                        ) : (
                            feedback
                        );
                    }}
                    onReset={reset}
                    resetKeys={resetKeys}
                >
                    {regionAttributes ? (
                        <section {...regionAttributes}>
                            <Suspense fallback={fallback}>{children}</Suspense>
                        </section>
                    ) : (
                        <Suspense fallback={fallback}>{children}</Suspense>
                    )}
                </ErrorBoundary>
            )}
        </QueryErrorResetBoundary>
    );
}
