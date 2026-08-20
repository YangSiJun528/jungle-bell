import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {describe, expect, test} from 'vitest';
import {createDashboardRouter} from './dashboard-router';
import {PrivacyPage} from './privacy-page';

const dashboardSource = readFileSync(new URL('./dashboard-app.tsx', import.meta.url), 'utf8');

function renderPrivacyPage(): string {
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/privacy']}));
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>
            <PrivacyPage/>
        </RouterContextProvider>,
    );
}

describe('개인정보 처리방침', () => {
    test('공개 문서에 버전과 필수 처리 항목을 표시한다', () => {
        const markup = renderPrivacyPage();

        expect(markup).toContain('개인정보 처리방침');
        expect(markup).toContain('시행일: 2026-08-20');
        expect(markup).toContain('버전: 1.0');
        expect(markup).toContain('1. 개인정보의 처리 목적');
        expect(markup).toContain('2. 수집하는 개인정보 항목');
        expect(markup).toContain('필수 항목');
        expect(markup).toContain('IP 주소, 쿠키, 기기정보, 서비스 이용기록');
        expect(markup).toContain('회원 탈퇴 또는 연결 계정 삭제 시까지');
        expect(markup).toContain('변경 고지 방법: 앱 내 공지');
    });

    test('대시보드에서 개인정보 확인 안내를 자동 노출하지 않는다', () => {
        expect(dashboardSource).not.toContain('UsagePrivacyNotice');
        expect(dashboardSource).not.toContain('usage-privacy-notice');
    });
});
