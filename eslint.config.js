import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/**/*.{js,mjs,cjs,ts,mts,cts}', 'examples/**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: { globals: globals.node }
  },
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts']
  },
  ...tseslint.configs.recommended,
];
