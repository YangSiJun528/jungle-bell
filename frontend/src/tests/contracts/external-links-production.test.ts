import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const productionSources = [
    '../../app/desktop-update-panel.tsx',
    '../../app/privacy-page.tsx',
    '../../app/shell/DashboardFooter.tsx',
    '../../features/app-install/app-install-page.tsx',
    '../../features/attendance/attendance-page.tsx',
    '../../features/home/jungle-campus-summary.tsx',
    '../../features/meals/components/meal-post-card.tsx',
    '../../features/meals/components/weekly-meal-menu.tsx',
    '../../platform/pwa/install-prompt.tsx',
] as const;

describe('production external links', () => {
    it.each(productionSources)('%s는 raw 새 창 API 대신 공통 ExternalLink를 사용한다', (file) => {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');

        expect(source).not.toMatch(/target=["']_blank["']|window\.open\(/u);
        expect(source).toContain("from '@/components/ui/external-link'");
    });
});
