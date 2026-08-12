import {existsSync, globSync, readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('React renewal architecture', () => {
    test('src root contains only stable Vite entry files', () => {
        const rootFiles = readdirSync(resolve(root, 'src'), {withFileTypes: true})
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort();

        expect(rootFiles).toEqual(['dashboard.html', 'env.d.ts']);
    });

    test('shared layers do not depend on features and features stay isolated', () => {
        const apiFiles = globSync('src/api/**/*.{ts,tsx}', {cwd: root});
        for (const path of apiFiles) {
            expect(read(path), path).not.toMatch(/['"]@\/features\//u);
        }

        const domainFiles = globSync('src/domain/**/*.{ts,tsx}', {cwd: root})
            .filter((path) => !path.includes('.test.'));
        for (const path of domainFiles) {
            expect(read(path), path).not.toMatch(/['"]@\/(?:api|app|features)\//u);
        }

        const featureFiles = globSync('src/features/*/**/*.{ts,tsx}', {cwd: root});
        for (const path of featureFiles) {
            const owner = path.split('/')[2];
            const importedFeatures = Array.from(
                read(path).matchAll(/(?:from\s+|import\()\s*['"]@\/features\/([^/'"]+)/gu),
                (match) => match[1],
            );
            expect(importedFeatures, path).toEqual(importedFeatures.filter((feature) => feature === owner));
        }
    });

    test('the dashboard is a React entry backed by TanStack Query', () => {
        const dashboard = read('src/dashboard.html');
        const packageJson = JSON.parse(read('package.json')) as {
            dependencies?: Record<string, string>;
        };

        expect(dashboard).toContain('<div id="root"></div>');
        expect(dashboard).toContain('type="module" src="/app/main.tsx"');
        expect(dashboard).not.toMatch(/\bx-(?:data|show|text|for|cloak)\b/u);
        expect(packageJson.dependencies).toHaveProperty('react');
        expect(packageJson.dependencies).toHaveProperty('react-dom');
        expect(packageJson.dependencies).toHaveProperty('@tanstack/react-query');
        expect(packageJson.dependencies).not.toHaveProperty('alpinejs');
    });

    test('shadcn components are vendored under the shared UI directory', () => {
        const components = JSON.parse(read('components.json')) as {
            aliases?: Record<string, string>;
        };

        expect(components.aliases?.ui).toBe('@/components/ui');
        expect(read('src/components/ui/badge.tsx')).toContain('data-slot="badge"');
        expect(read('src/components/ui/button.tsx')).toContain('data-slot="button"');
        expect(read('src/components/ui/card.tsx')).toContain('data-slot="card"');
        expect(read('src/components/ui/card.tsx')).toContain('data-slot="card-action"');
    });

    test('the dashboard reserves badges for laundry zone and warning identification', () => {
        const dashboardFiles = globSync('src/{app,components/dashboard,features}/**/*.tsx', {cwd: root});
        const siteStyles = read('src/site/styles/global.css');
        const badgeAllowedFiles = new Set([
            'src/features/laundry/components/laundry-zone-badge.tsx',
            'src/features/laundry/components/laundry-warning-badge.tsx',
        ]);

        expect(existsSync(resolve(root, 'src/components/ui/badge.tsx'))).toBe(true);
        expect(existsSync(resolve(root, 'src/components/dashboard/status-badge.tsx'))).toBe(false);
        for (const path of dashboardFiles) {
            if (badgeAllowedFiles.has(path)) continue;
            expect(read(path), path).not.toMatch(/components\/(?:ui\/badge|dashboard\/status-badge)/u);
            expect(read(path), path).not.toMatch(/<(?:Badge|StatusBadge)\b/u);
        }

        const zoneBadge = read('src/features/laundry/components/laundry-zone-badge.tsx');
        expect(zoneBadge).toMatch(/components\/ui\/badge/u);
        expect(zoneBadge).toMatch(/<Badge\b/u);

        const warningBadge = read('src/features/laundry/components/laundry-warning-badge.tsx');
        expect(warningBadge).toMatch(/components\/ui\/badge/u);
        expect(warningBadge).toMatch(/<Badge\b/u);
        expect(warningBadge).toMatch(/TriangleAlert/u);

        const shell = read('src/app/shell/DashboardShell.tsx');
        expect(shell).not.toContain('SURFACE_LABELS');
        expect(shell).not.toContain('현재 접속 환경');
        expect(shell).not.toContain('compactCount');
        expect(siteStyles).not.toMatch(/\.category\s*\{[^}]*(?:background|border-radius|padding)/u);
    });

    test('the frontend uses flat surfaces without gradients', () => {
        const sourceFiles = globSync('src/**/*.{astro,css,html,tsx}', {cwd: root});

        for (const path of sourceFiles) {
            expect(read(path), path).not.toMatch(/(?:bg-gradient|linear-gradient|radial-gradient|conic-gradient)/u);
        }
    });

    test('the static Astro blog lives below src and stays outside React hydration', () => {
        const packageJson = JSON.parse(read('package.json')) as {workspaces?: string[]};
        const layout = read('src/site/layouts/BaseLayout.astro');

        expect(packageJson.workspaces ?? []).not.toContain('site');
        expect(read('astro.config.mjs')).toContain("output: 'static'");
        expect(layout).not.toMatch(/client:(?:load|idle|visible|media|only)/u);
        expect(layout).not.toMatch(/from ['"]react['"]/u);
    });
});
