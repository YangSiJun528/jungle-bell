import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

import {PwaUpdateNotice} from './pwa-update-controller';

const actions = {
    actionError: false,
    activating: false,
    onActivate: vi.fn<() => void>(),
    onRetry: vi.fn<() => void>(),
} as const;

describe('PwaUpdateNotice', () => {
    it('waiting 업데이트는 사용자 확인 전까지 reload하지 않는 적용 버튼을 표시한다', () => {
        const markup = renderToStaticMarkup(
            <PwaUpdateNotice {...actions} snapshot={{status: 'ready', error: null}} />,
        );

        expect(markup).toContain('새 버전을 사용할 수 있습니다.');
        expect(markup).toContain('입력 보존 후 업데이트');
        expect(markup).toContain('선택해야만');
    });

    it('updatefound 설치 중에는 자동 reload 없이 준비 상태만 알린다', () => {
        const markup = renderToStaticMarkup(
            <PwaUpdateNotice {...actions} snapshot={{status: 'installing', error: null}} />,
        );

        expect(markup).toContain('새 버전을 준비하고 있습니다.');
        expect(markup).not.toContain('입력 보존 후 업데이트');
    });

    it('activation 실패는 현재 화면 유지와 재시도 경로를 안내한다', () => {
        const markup = renderToStaticMarkup(
            <PwaUpdateNotice
                {...actions}
                snapshot={{status: 'failed', error: 'PWA_UPDATE_ACTIVATION_TIMEOUT'}}
            />,
        );

        expect(markup).toContain('업데이트를 준비하지 못했습니다.');
        expect(markup).toContain('현재 화면은 그대로 유지됩니다.');
        expect(markup).toContain('업데이트 다시 준비');
    });

    it('입력 보존 실패는 registration 재시도 대신 보존 적용을 다시 시도한다', () => {
        const markup = renderToStaticMarkup(
            <PwaUpdateNotice {...actions} actionError snapshot={{status: 'ready', error: null}} />,
        );

        expect(markup).toContain('입력을 보존하지 못했습니다.');
        expect(markup).toContain('입력 보존 후 업데이트');
        expect(markup).not.toContain('업데이트 다시 준비');
    });
});
