import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

import {ExternalLink} from './external-link';

const PROJECT_URL = 'https://github.com/YangSiJun528/jungle-bell';

describe('ExternalLink', () => {
    it('새 창 링크의 보안 속성과 호출자가 제공한 접근 가능한 이름을 고정한다', () => {
        const markup = renderToStaticMarkup(
            <ExternalLink href={PROJECT_URL} aria-label="Jungle Bell GitHub 열기">
                GitHub
            </ExternalLink>,
        );

        expect(markup).toContain(`href="${PROJECT_URL}"`);
        expect(markup).toContain('target="_blank"');
        expect(markup).toContain('rel="noopener noreferrer"');
        expect(markup).toContain('aria-label="Jungle Bell GitHub 열기"');
    });

    it('Tauri opener를 주입하면 브라우저 탐색을 막고 실패를 콜백으로 반환한다', async () => {
        const error = new Error('SYSTEM_BROWSER_OPEN_FAILED');
        const openExternally = vi.fn<(url: string) => Promise<void>>(async () => {
            throw error;
        });
        const onOpenError = vi.fn<(error: unknown) => void>();
        const element = ExternalLink({
            href: PROJECT_URL,
            openExternally,
            onOpenError,
            children: 'GitHub',
        });
        const event = new Event('click', {cancelable: true});
        const handler = element.props.onClick;
        if (!handler) throw new Error('onClick handler is required');

        await Reflect.apply(handler, undefined, [event]);

        expect(event.defaultPrevented).toBe(true);
        expect(openExternally).toHaveBeenCalledWith(PROJECT_URL);
        expect(onOpenError).toHaveBeenCalledWith(error);
    });

    it('허용 목록 밖 URL은 anchor를 만들기 전에 거부한다', () => {
        expect(() => ExternalLink({href: 'javascript:alert(1)', children: 'bad'})).toThrow(
            'EXTERNAL_URL_NOT_ALLOWED',
        );
    });
});
