import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';

import {SwitchRow} from './switch';

describe('SwitchRow', () => {
    test('exposes a full-row label with an accessible description', () => {
        const markup = renderToStaticMarkup(
            createElement(SwitchRow, {
                checked: false,
                description: '브라우저에 저장됩니다.',
                label: '사용량 통계 허용',
                onCheckedChange: () => undefined,
            }),
        );

        expect(markup).toContain('data-slot="switch-row"');
        expect(markup).toContain('<label');
        expect(markup).toContain('사용량 통계 허용');
        expect(markup).toContain('브라우저에 저장됩니다.');
        expect(markup).toMatch(/role="switch"[^>]+aria-labelledby=/u);
        expect(markup).toMatch(/role="switch"[^>]+aria-describedby=/u);
    });
});
