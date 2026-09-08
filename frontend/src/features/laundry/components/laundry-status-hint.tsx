import {Info} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

export function LaundryStatusHint({children, label}: {children: ReactNode; label: string}) {
    const [open, setOpen] = useState(false);

    return (
        <Tooltip open={open} onOpenChange={setOpen}>
            <TooltipTrigger asChild>
                <button
                    aria-expanded={open}
                    aria-label={label}
                    className="inline-grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    data-laundry-status-hint="true"
                    type="button"
                    onClick={() => setOpen((current) => !current)}
                >
                    <Info className="size-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72 text-base" sideOffset={6}>
                <div className="space-y-1.5 leading-6 break-keep">{children}</div>
            </TooltipContent>
        </Tooltip>
    );
}
