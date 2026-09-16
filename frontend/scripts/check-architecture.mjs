import {spawnSync} from 'node:child_process';
import {globSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {cruise, format} from 'dependency-cruiser';

import configuration from '../.dependency-cruiser.cjs';

const {values} = parseArgs({options: {'output-type': {type: 'string', default: 'err-long'}}});
const sources = globSync('src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}').map((source) =>
    source.replaceAll('\\', '/'),
);
if (sources.length === 0) throw new Error('Incomplete architecture scan: no source files found');
// SWC does not extract import() types or triple-slash path references reliably.
// Require explicit import declarations with Oxlint before building the graph.
const oxlint = fileURLToPath(new URL('./bin/oxlint', import.meta.resolve('oxlint/package.json')));
const syntax = spawnSync(
    process.execPath,
    [
        oxlint,
        '--config',
        fileURLToPath(new URL('../.oxlint-architecture.json', import.meta.url)),
        '--disable-nested-config',
        '--format',
        'json',
        'src',
    ],
    {encoding: 'utf8'},
);
if (syntax.error) throw syntax.error;
if (syntax.status !== 0) {
    process.stdout.write(syntax.stdout);
    process.stderr.write(syntax.stderr);
    process.exit(syntax.status ?? 1);
}
const {compilerOptions} = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
const aliases = Object.fromEntries(
    Object.entries(compilerOptions.paths).map(([name, targets]) => [
        name.replace(/\/\*$/u, ''),
        targets.map((target) => resolve(target.replace(/\/\*$/u, ''))),
    ]),
);
const result = await cruise(
    ['src'],
    {...configuration.options, ruleSet: configuration, validate: true},
    {alias: aliases},
);
const graph = result.output;

// A missing parser must fail, even when the remaining JavaScript graph is valid.
const scanned = new Set(graph.modules.map((module) => module.source));
const missing = sources.filter((source) => !scanned.has(source));
if (graph.summary.environment?.issues?.length || missing.length) {
    throw new Error(
        `Incomplete architecture scan: ${JSON.stringify({missing, environment: graph.summary.environment})}`,
    );
}

const report = await format(graph, {outputType: values['output-type']});
process.stdout.write(
    `${typeof report.output === 'string' ? report.output : JSON.stringify(report.output)}\n`,
);
process.exitCode = graph.summary.error > 0 ? 1 : 0;
