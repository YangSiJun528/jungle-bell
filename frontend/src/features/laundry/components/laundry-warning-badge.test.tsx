import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {LaundryWarningBadge} from './laundry-warning-badge';

describe('LaundryWarningBadge', () => {
    it('상단 범례에서는 아이콘 없이 여성 구역과 구분되는 주황을 사용한다', () => {
        const markup = renderToStaticMarkup(<LaundryWarningBadge />);

        expect(markup).toContain('aria-label="경고 상태"');
        expect(markup).toContain('data-laundry-warning="true"');
        expect(markup).toContain('border-orange-400 bg-orange-100');
        expect(markup).toContain('text-orange-800');
        expect(markup).not.toContain('bg-rose-100');
        expect(markup).not.toContain('lucide-triangle-alert');
    });
});
