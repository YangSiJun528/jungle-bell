import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./dashboard-route-pages.tsx', import.meta.url), 'utf8');
const connectionsSource = readFileSync(
    new URL('../features/connections/connections-page.tsx', import.meta.url),
    'utf8',
);

describe('connections production route wiring', () => {
    test('typed search를 실제 탭과 App Status slot에 연결한다', () => {
        expect(source).toContain("useSearch({from: '/connections'})");
        expect(source).toContain("useNavigate({from: '/connections'})");
        expect(source).toContain('renderAppStatus={() =>');
        expect(source).toContain('<AppStatusPage');
        expect(source).toContain('returnTo={search.returnTo}');
    });

    test('탭 변경은 returnTo를 보존하며 URL hash를 직접 쓰지 않는다', () => {
        expect(source).toMatch(/search:\s*\(previous\) => \(\{\.\.\.previous, tab\}\)/u);
        expect(connectionsSource).not.toContain('window.location.hash');
        expect(connectionsSource).not.toContain("from './connections-tabs'");
    });
});
