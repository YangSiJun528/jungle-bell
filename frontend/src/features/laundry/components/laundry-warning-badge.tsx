import {Badge} from '@/components/ui/badge';
import {LAUNDRY_WARNING_CLASS_NAME} from '../lib/laundry-warning';

export function LaundryWarningBadge() {
    return (
        <Badge
            aria-label="경고 상태"
            className={LAUNDRY_WARNING_CLASS_NAME}
            data-laundry-warning="true"
            variant="outline"
        >
            경고
        </Badge>
    );
}
