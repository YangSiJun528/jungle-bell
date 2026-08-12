import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {LaundryWarningBadge} from './laundry-warning-badge';

describe('LaundryWarningBadge', () => {
    it('여성 구역과 구분되는 저채도 빨강 및 경고 기호를 사용한다', () => {
        const markup = renderToStaticMarkup(<LaundryWarningBadge/>);

        expect(markup).toContain('aria-label="경고 상태"');
        expect(markup).toContain('data-laundry-warning="true"');
        expect(markup).toContain('bg-red-50/70');
        expect(markup).toContain('text-red-700');
        expect(markup).not.toContain('bg-rose-50/60');
        expect(markup).toContain('lucide-triangle-alert');
    });
});
