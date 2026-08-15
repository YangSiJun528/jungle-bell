import {Badge} from '@/components/ui/badge';
import {
    laundryZonePresentation,
    type LaundryZone,
} from '@/components/dashboard/laundry-zone-presentation';

export function LaundryZoneBadge({zone}: {zone: LaundryZone}) {
    const meta = laundryZonePresentation(zone);

    return (
        <Badge
            aria-label={meta.label}
            className={meta.surfaceClassName}
            data-laundry-zone={zone}
            variant="outline"
        >
            {meta.shortLabel}
        </Badge>
    );
}
