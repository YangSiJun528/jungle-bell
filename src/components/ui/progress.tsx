import * as React from 'react';
import {Progress as ProgressPrimitive} from 'radix-ui';
import {cn} from '@/lib/utils';

function Progress({
    className,
    value,
    ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
    const normalizedValue = typeof value === 'number'
        ? Math.min(100, Math.max(0, value))
        : 0;

    return (
        <ProgressPrimitive.Root
            className={cn(
                'relative h-2 w-full overflow-hidden rounded-full bg-primary/15',
                className,
            )}
            data-slot="progress"
            value={value}
            {...props}
        >
            <ProgressPrimitive.Indicator
                className="h-full w-full flex-1 bg-primary transition-transform"
                data-slot="progress-indicator"
                style={{transform: `translateX(-${100 - normalizedValue}%)`}}
            />
        </ProgressPrimitive.Root>
    );
}

export {Progress};
