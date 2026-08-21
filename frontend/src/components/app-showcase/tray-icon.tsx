import {useId} from 'react';

import {cn} from '@/lib/utils';

export type TrayIconStatus = 'alert' | 'warning' | 'normal' | 'offline';

const STATUS_COLOR: Readonly<Record<TrayIconStatus, string>> = {
    alert: 'text-[#b4232c]',
    warning: 'text-[#a94d00]',
    normal: 'text-[#24313b]',
    offline: 'text-[#536170]',
};

export function TrayIcon({
    status,
    label,
    className,
}: {
    status: TrayIconStatus;
    label: string;
    className?: string;
}) {
    const maskId = useId();

    return (
        <svg
            viewBox="0 0 44 44"
            role="img"
            aria-label={label}
            className={cn('size-9 shrink-0', STATUS_COLOR[status], className)}
            xmlns="http://www.w3.org/2000/svg"
        >
            <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
                    <rect x="3" y="3" width="38" height="38" rx="10" fill="white" />
                    <circle cx="22" cy="22" r="16" fill="black" />
                </mask>
            </defs>
            <rect
                x="3"
                y="3"
                width="38"
                height="38"
                rx="10"
                fill="currentColor"
                mask={`url(#${maskId})`}
            />
            <rect
                x="3"
                y="3"
                width="38"
                height="38"
                rx="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
            />
            <g fill="currentColor" transform="translate(3.5 3.5) scale(.0361328125)">
                <path d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768zm0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896z" />
                <path d="M725.888 315.008C676.48 428.672 624 513.28 568.576 568.64c-55.424 55.424-139.968 107.904-253.568 157.312a12.8 12.8 0 0 1-16.896-16.832c49.536-113.728 102.016-198.272 157.312-253.632 55.36-55.296 139.904-107.776 253.632-157.312a12.8 12.8 0 0 1 16.832 16.832z" />
            </g>
        </svg>
    );
}
