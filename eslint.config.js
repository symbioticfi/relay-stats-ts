import js from '@eslint/js';
import tsparser from '@typescript-eslint/parser';
import tsplugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

const config = [
    js.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        plugins: {
            '@typescript-eslint': tsplugin,
        },
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            'no-undef': 'off', // TypeScript handles this
            'no-console': 'warn',
            'prefer-const': 'error',
            'no-var': 'error',
            'no-redeclare': 'error',
        },
    },
    {
        files: ['check-diff.ts', 'tsup.config.ts', 'examples/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
        rules: {
            'no-console': 'off',
        },
    },
    {
        ignores: [
            // Dependencies
            'node_modules/',
            'pnpm-lock.yaml',
            '.pnpm/',

            // Build outputs
            'dist/',
            'build/',
            'examples/dist/',
            '.next/',
            'out/',
            'src/dist/',
            'client/dist/',

            // Generated files
            'generated/',
            '*.generated.*',

            // API client generated files
            'src/api/client/',
            'client/dist/',

            // Logs
            '*.log',
            'logs/',
            'npm-debug.log*',
            'yarn-debug.log*',
            'yarn-error.log*',
            '.pnpm-debug.log*',

            // OS generated files
            '.DS_Store',
            '.DS_Store?',
            '._*',
            '.Spotlight-V100',
            '.Trashes',
            'ehthumbs.db',
            'Thumbs.db',

            // IDE files
            '.vscode/',
            '.idea/',
            '*.swp',
            '*.swo',

            // Archive files
            '*.tar.gz',
            '*.zip',
            '*.rar',

            // API specs (often auto-generated)
            'specs/',
            '*.yaml',
            '*.yml',

            // Large data files
            '*.json',
            'resp.json',

            // Env files
            '.env*.local',

            // Temporary files
            '*.tmp',
            '*.temp',
        ],
    },
];

export default config;
