import {QueryErrorResetBoundary} from '@tanstack/react-query';
import {Suspense, type ReactNode} from 'react';
import {ErrorBoundary} from 'react-error-boundary';

import {ErrorState, PageSkeleton} from './async-state';

interface AsyncBoundaryProps {
    children: ReactNode;
    errorDescription?: string;
    errorTitle?: string;
    fallback?: ReactNode;
    resetKeys?: unknown[];
}

/** Declarative loading and error boundary for query-backed dashboard regions. */
export function AsyncBoundary({
    children,
    errorDescription,
    errorTitle,
    fallback = <PageSkeleton />,
    resetKeys,
}: AsyncBoundaryProps) {
    return (
        <QueryErrorResetBoundary>
            {({reset}) => (
                <ErrorBoundary
                    fallbackRender={({resetErrorBoundary}) => (
                        <ErrorState
                            description={errorDescription}
                            retry={resetErrorBoundary}
                            title={errorTitle}
                        />
                    )}
                    onReset={reset}
                    resetKeys={resetKeys}
                >
                    <Suspense fallback={fallback}>{children}</Suspense>
                </ErrorBoundary>
            )}
        </QueryErrorResetBoundary>
    );
}
