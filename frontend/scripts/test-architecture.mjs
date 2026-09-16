import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const checker = fileURLToPath(new URL('./check-architecture.mjs', import.meta.url));
const baseFiles = {
    'tsconfig.json': JSON.stringify({compilerOptions: {paths: {'@/*': ['./src/*']}}}),
    'src/lib/value.ts': 'export const value = 1;',
    'src/domain/model.ts': 'export interface Model { value: number }',
    'src/api/client.ts': "export {value} from '@/lib/value';",
    'src/state/session.ts': "export {value} from '@/api/client';",
    'src/features/attendance/model.ts': "export {value} from '@/state/session';",
    'src/features/meals/model.ts': 'export const meal = 1;',
    'src/app/bootstrap.ts': "export {value} from '@/features/attendance/model';",
    'src/platform/contracts.ts': 'export interface Platform { kind: string }',
    'src/platform/tauri/adapter.ts': 'export const adapter = 1;',
};

function checkFixture(files, includeBase = true) {
    const directory = mkdtempSync(join(tmpdir(), 'jungle-bell-architecture-'));
    try {
        mkdirSync(join(directory, 'src'));
        for (const [path, source] of Object.entries({
            ...(includeBase ? baseFiles : {}),
            ...files,
        })) {
            const target = join(directory, path);
            mkdirSync(dirname(target), {recursive: true});
            writeFileSync(target, source);
        }
        const result = spawnSync(process.execPath, [checker, '--output-type', 'json'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.ifError(result.error);
        const graph = result.stdout.trim() ? JSON.parse(result.stdout) : null;
        if (graph)
            assert.equal(result.stderr, '', 'the parser and resolver must run without errors');
        return {status: result.status, graph, stderr: result.stderr};
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}

test('allowed layers, TSX, type imports and composition entries are scanned', () => {
    const {status, graph} = checkFixture({
        'src/features/attendance/page.tsx': `
            import type {Model} from '@/domain/model';
            import {value} from './model';
            export const Page = (props: Model) => <div>{value + props.value}</div>;
        `,
        'src/platform/tauri/entry.ts': "export {value} from '@/app/bootstrap';",
    });
    assert.equal(status, 0);
    assert.equal(graph.summary.error, 0);
    const page = graph.modules.find((module) => module.source.endsWith('/page.tsx'));
    assert.ok(page, 'TSX must not silently disappear from the scan');
    assert.ok(
        page.dependencies.some((dependency) => dependency.resolved === 'src/domain/model.ts'),
    );
});

test('aliases, relative paths, re-exports, dynamic imports and type imports obey boundaries', () => {
    const illegalSources = {
        alias: "import {value} from '@/app/bootstrap'; export {value};",
        relative: "import {value} from '../app/bootstrap'; export {value};",
        reexport: "export {value} from '@/app/bootstrap';",
        dynamic: "export const load = () => import('@/app/bootstrap');",
        type: "import type {Model} from '@/api/model'; export type Copy = Model;",
    };
    const {status, graph} = checkFixture({
        'src/api/model.ts': 'export interface Model { value: number }',
        ...Object.fromEntries(
            Object.entries(illegalSources).map(([name, source]) => [
                `src/domain/${name}.ts`,
                source,
            ]),
        ),
    });
    assert.equal(status, 1, 'architecture violations must fail the command used by CI');
    for (const name of Object.keys(illegalSources)) {
        assert.ok(
            graph.summary.violations.some(
                (violation) =>
                    violation.from === `src/domain/${name}.ts` &&
                    violation.rule.name === 'domain-dependencies',
            ),
            `${name} must be rejected by the production rule set`,
        );
    }
});

test('feature isolation, platform internals, UI and state boundaries reject reverse imports', () => {
    const cases = [
        ['src/features/attendance/cross.ts', '../meals/model', 'isolated-features'],
        ['src/features/attendance/native.ts', '@/platform/tauri/adapter', 'features-dependencies'],
        ['src/state/reverse.ts', '@/app/bootstrap', 'state-dependencies'],
        ['src/app/native.ts', '@/platform/tauri/adapter', 'app-dependencies'],
        ['src/components/ui/reverse.ts', '@/state/session', 'ui-dependencies'],
        ['src/platform/pwa/reverse.ts', '@/platform/tauri/adapter', 'isolated-platforms'],
    ];
    const {status, graph} = checkFixture(
        Object.fromEntries(cases.map(([path, target]) => [path, `export * from '${target}';`])),
    );
    assert.equal(status, 1);
    for (const [path, , rule] of cases) {
        assert.ok(
            graph.summary.violations.some(
                (violation) => violation.from === path && violation.rule.name === rule,
            ),
            `${rule} must reject ${path}`,
        );
    }
});

test('cycles, unresolved imports and production dependencies on test files fail', () => {
    const {status, graph} = checkFixture({
        'src/lib/a.ts': "export {b} from './b'; export const a = 1;",
        'src/lib/b.ts': "export {a} from './a'; export const b = 2;",
        'src/lib/helper.test.ts': 'export const helper = 1;',
        'src/lib/uses-test.ts': "export {helper} from './helper.test';",
        'src/lib/missing.ts': "export * from './does-not-exist';",
    });
    assert.equal(status, 1);
    const rules = new Set(graph.summary.violations.map((violation) => violation.rule.name));
    for (const rule of [
        'no-circular-dependencies',
        'no-production-to-tests',
        'no-unresolved-imports',
    ]) {
        assert.ok(rules.has(rule), `${rule} must detect the injected violation`);
    }
});

test('type expressions and local triple-slash references cannot bypass SWC dependency extraction', () => {
    const {status, graph} = checkFixture({
        'src/domain/plain.ts': "export type Copy = import('@/api/model').Model;",
        'src/domain/nested.ts': "export type Copy = Promise<import('@/api/model').Model>;",
        'src/domain/query.ts': "export type Copy = typeof import('@/app/bootstrap');",
        'src/domain/reference.ts': '/// <reference path="../app/bootstrap.ts" />\nexport {};',
        'src/api/model.ts': 'export interface Model { value: number }',
    });
    assert.equal(status, 1);
    for (const name of ['plain', 'nested', 'query', 'reference']) {
        assert.ok(
            graph.diagnostics.some((diagnostic) => diagnostic.filename === `src/domain/${name}.ts`),
            `${name} must be rejected before dependency analysis`,
        );
    }
});

test('an empty source scan fails instead of reporting successful architecture validation', () => {
    const {status, stderr} = checkFixture({'tsconfig.json': baseFiles['tsconfig.json']}, false);
    assert.equal(status, 1);
    assert.match(stderr, /Incomplete architecture scan/u);
});
