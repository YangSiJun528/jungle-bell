const tests = '(?:\\.test\\.[cm]?[jt]sx?$|^src/tests/)';
const platformContracts = '^src/platform/[^/]+\\.ts$';

// Paths are resolved by dependency-cruiser, so aliases and relative imports obey
// the same rules. Type-only dependencies are part of the architecture as well.
/** @type {Array<[string, string, string[]]>} */
const layers = [
    [
        'app',
        '^src/app/',
        [
            '^src/(app|features|components|hooks|state|navigation|api|domain|lib|assets)/',
            platformContracts,
            '^src/platform/pwa/update-(bootstrap|lifecycle)\\.ts$',
        ],
    ],
    ['lib', '^src/lib/', ['^src/lib/']],
    ['domain', '^src/domain/', ['^src/(domain|lib)/']],
    ['navigation', '^src/navigation/', ['^src/(navigation|domain|lib)/']],
    ['api', '^src/api/', ['^src/(api|domain|lib)/', platformContracts]],
    ['state', '^src/state/', ['^src/(state|api|domain|navigation|lib)/', platformContracts]],
    ['hooks', '^src/hooks/', ['^src/(hooks|lib)/', platformContracts]],
    ['ui', '^src/components/ui/', ['^src/components/ui/', '^src/(hooks|lib)/']],
    [
        'components',
        '^src/components/(?!ui/)',
        ['^src/(components|hooks|state|navigation|api|domain|lib|assets)/', platformContracts],
    ],
    [
        'features',
        '^src/features/',
        [
            '^src/(features|components|hooks|state|navigation|api|domain|lib|assets)/',
            platformContracts,
        ],
    ],
    ['platform-contracts', platformContracts, ['^src/(api|domain|lib)/', platformContracts]],
    [
        'platform-implementation',
        '^src/platform/(web|pwa|tauri)/(?!entry\\.ts$)',
        ['^src/platform/', '^src/(domain|lib)/'],
    ],
];

module.exports = {
    forbidden: [
        ...layers.map(([name, source, allowed]) => ({
            name: `${name}-dependencies`,
            severity: 'error',
            comment: 'Import only the lower layers listed in docs/reference-module-boundaries.md.',
            from: {path: source, pathNot: tests},
            to: {path: '^src/', pathNot: allowed},
        })),
        {
            name: 'isolated-features',
            severity: 'error',
            comment: 'Compose features in app; share reusable behavior through lower layers.',
            from: {path: '^src/features/([^/]+)/', pathNot: tests},
            to: {path: '^src/features/', pathNot: '^src/features/$1/'},
        },
        {
            name: 'isolated-platforms',
            severity: 'error',
            from: {path: '^src/platform/(tauri|pwa|web)/(?!entry\\.ts$)', pathNot: tests},
            to: {path: '^src/platform/(tauri|pwa|web)/', pathNot: '^src/platform/$1/'},
        },
        {
            name: 'platform-entries-only-from-main',
            severity: 'error',
            from: {pathNot: ['^src/main\\.ts$', tests]},
            to: {path: '^src/platform/(web|tauri)/entry\\.ts$'},
        },
        {
            name: 'tauri-api-only-in-tauri',
            severity: 'error',
            from: {pathNot: ['^src/platform/tauri/', tests]},
            to: {path: '(^|/)node_modules/@tauri-apps/'},
        },
        {
            name: 'no-production-to-tests',
            severity: 'error',
            from: {pathNot: tests},
            to: {path: tests},
        },
        {
            name: 'no-circular-dependencies',
            severity: 'error',
            from: {path: '^src/', pathNot: tests},
            to: {path: '^src/', circular: true},
        },
        {
            name: 'no-unresolved-imports',
            severity: 'error',
            from: {},
            to: {couldNotResolve: true},
        },
    ],
    options: {
        // dependency-cruiser 18 does not support the TypeScript 7 compiler API.
        // SWC parses TS/TSX (including type imports) without that compiler API.
        parser: 'swc',
        enhancedResolveOptions: {
            exportsFields: ['exports'],
            conditionNames: ['import', 'require', 'node', 'default', 'types'],
            mainFields: ['module', 'main', 'types'],
        },
        doNotFollow: {path: 'node_modules'},
    },
};
