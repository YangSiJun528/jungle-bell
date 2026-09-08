'use client';

import {Switch as SwitchPrimitive} from 'radix-ui';
import * as React from 'react';

import {cn} from '@/lib/utils';

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
    size?: 'sm' | 'default';
};

function Switch({className, size = 'default', ...props}: SwitchProps) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            data-size={size}
            className={cn(
                "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none after:absolute after:top-1/2 after:left-1/2 after:size-(--hit-area-min) after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-6 data-[size=default]:w-11 data-[size=sm]:h-5 data-[size=sm]:w-9 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
                className,
            )}
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className={cn(
                    'pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-4 data-[state=checked]:translate-x-5 group-data-[size=sm]/switch:data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground',
                )}
            />
        </SwitchPrimitive.Root>
    );
}

type SwitchRowProps = Omit<
    SwitchProps,
    'aria-describedby' | 'aria-label' | 'aria-labelledby' | 'className'
> & {
    label: React.ReactNode;
    description?: React.ReactNode;
    className?: string;
    switchClassName?: string;
};

function SwitchRow({
    label,
    description,
    className,
    switchClassName,
    ...switchProps
}: SwitchRowProps) {
    const labelId = React.useId();
    const descriptionId = React.useId();

    return (
        <label
            data-slot="switch-row"
            className={cn(
                'flex min-h-(--control-height-lg) cursor-pointer items-center justify-between gap-4 rounded-md py-2 has-[button:disabled]:cursor-not-allowed has-[button:disabled]:opacity-60',
                className,
            )}
        >
            <span className="min-w-0">
                <span id={labelId} className="block text-base font-medium">
                    {label}
                </span>
                {description ? (
                    <span
                        id={descriptionId}
                        className="mt-1 block text-sm leading-5 text-muted-foreground"
                    >
                        {description}
                    </span>
                ) : null}
            </span>
            <Switch
                aria-labelledby={labelId}
                aria-describedby={description ? descriptionId : undefined}
                className={switchClassName}
                {...switchProps}
            />
        </label>
    );
}

export {Switch, SwitchRow};
export type {SwitchProps, SwitchRowProps};
