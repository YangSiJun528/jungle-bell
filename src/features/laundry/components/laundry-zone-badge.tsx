import {Badge} from '@/components/ui/badge';
import {laundryZoneMeta, type LaundryZone} from '../lib/laundry-zone';

export function LaundryZoneBadge({zone}: {zone: LaundryZone}) {
    const meta = laundryZoneMeta(zone);

    return (
        <Badge
            aria-label={meta.label}
            className={meta.badgeClassName}
            data-laundry-zone={zone}
            variant="outline"
        >
            {meta.shortLabel}
        </Badge>
    );
}
