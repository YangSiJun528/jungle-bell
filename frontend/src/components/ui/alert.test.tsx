import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';

import {Alert} from './alert';

describe('Alert live-region semantics', () => {
    test('static guidance is not announced as an urgent alert by default', () => {
        const markup = renderToStaticMarkup(createElement(Alert, null, '안내'));

        expect(markup).not.toContain('role="alert"');
        expect(markup).not.toContain('role="status"');
    });

    test('destructive feedback is urgent and callers can select a polite status', () => {
        const errorMarkup = renderToStaticMarkup(
            createElement(Alert, {variant: 'destructive'}, '오류'),
        );
        const statusMarkup = renderToStaticMarkup(createElement(Alert, {role: 'status'}, '완료'));

        expect(errorMarkup).toContain('role="alert"');
        expect(statusMarkup).toContain('role="status"');
    });
});
