import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./dashboard-app.tsx', import.meta.url), 'utf8');

describe('DashboardApp personal access boundaries', () => {
    test('공유 shell 내부의 route content에만 인증 gate를 둔다', () => {
        const shellStart = source.indexOf('<DashboardShell');
        const shellEnd = source.indexOf('</DashboardShell>');
        const gate = source.indexOf('<PlatformAuthenticationGate', shellStart);

        expect(shellStart).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(shellStart);
        expect(gate).toBeLessThan(shellEnd);
        expect(source).toMatch(
            /<PlatformAuthenticationGate[\s\S]*enabled=\{isPersonalDashboardRoute\(contentRoute\)\}[\s\S]*<Outlet\s*\/>/u,
        );
    });

    test('privacy route는 dashboard shell 밖의 공개 outlet을 보존한다', () => {
        expect(source).toContain("if (pathname === '/privacy') return <PublicRouteOutlet />;");
    });
});
